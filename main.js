'use strict';

const { app, BrowserWindow, ipcMain, Notification, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

let configCache = null;

function readConfig() {
  if (configCache) return configCache;
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (raw.passwordEncrypted && safeStorage.isEncryptionAvailable()) {
      raw.password = safeStorage.decryptString(Buffer.from(raw.passwordEncrypted, 'base64'));
      delete raw.passwordEncrypted;
    }
    configCache = raw;
    return raw;
  } catch {
    return {};
  }
}

function writeConfig(data) {
  const toWrite = { ...data };
  if (toWrite.password !== undefined) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system. Password cannot be saved safely.');
    }
    toWrite.passwordEncrypted = safeStorage.encryptString(toWrite.password).toString('base64');
    delete toWrite.password;
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2), 'utf8');
  configCache = null;
}

// ─── Input Validation ─────────────────────────────────────────────────────────

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;

function isValidHost(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.trim();
  if (IPV4_RE.test(h)) {
    return h.split('.').every(octet => parseInt(octet, 10) <= 255);
  }
  return HOSTNAME_RE.test(h);
}

// ─── Pi-hole API Client ───────────────────────────────────────────────────────

// In-memory session state — never written to disk
const session = { sid: null, host: null, protocol: 'http' };

function buildUrl(path) {
  return `${session.protocol}://${session.host}/api${path}`;
}

function fetchOptions(method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    // Allow self-signed certs on local networks when user opts in
    ...(session.allowSelfSigned ? { agent: new (require('https').Agent)({ rejectUnauthorized: false }) } : {})
  };
  if (body) opts.body = JSON.stringify(body);
  return opts;
}

async function apiFetch(urlPath, method = 'GET', body = null, retry = true) {
  const sep = urlPath.includes('?') ? '&' : '?';
  const url = buildUrl(urlPath) + (session.sid ? `${sep}sid=${encodeURIComponent(session.sid)}` : '');
  const res = await fetch(url, fetchOptions(method, body));

  if (res.status === 401 && retry) {
    await authenticate();
    return apiFetch(urlPath, method, body, false);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error ${res.status}: ${text}`);
  }

  return res.json();
}

async function logout() {
  if (!session.sid || !session.host) return;
  try {
    const url = buildUrl('/auth') + `?sid=${encodeURIComponent(session.sid)}`;
    await fetch(url, {
      method: 'DELETE',
      ...(session.allowSelfSigned ? { agent: new (require('https').Agent)({ rejectUnauthorized: false }) } : {})
    });
  } catch {
    // Best-effort — if the network is gone the session will expire on its own
  } finally {
    session.sid = null;
  }
}

async function authenticate() {
  const config = readConfig();
  if (!config.host) throw new Error('No Pi-hole host configured.');
  if (!config.password) throw new Error('No password configured.');

  session.host = config.host;
  session.protocol = config.protocol || 'http';
  session.allowSelfSigned = config.allowSelfSigned || false;

  // Close any existing session before opening a new one to avoid exhausting
  // Pi-hole's webserver.api.max_sessions limit.
  await logout();

  const password = config.password;
  const url = `${session.protocol}://${session.host}/api/auth`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    ...(session.allowSelfSigned ? { agent: new (require('https').Agent)({ rejectUnauthorized: false }) } : {})
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Authentication failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.session?.sid) throw new Error('No session token returned by Pi-hole.');
  session.sid = data.session.sid;
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

handle('config:read', () => {
  const cfg = readConfig();
  // Never send decrypted password back to renderer
  return { host: cfg.host || '', protocol: cfg.protocol || 'http', allowSelfSigned: cfg.allowSelfSigned || false, hasPassword: !!cfg.password, notifyThresholdCount: cfg.notifyThresholdCount || 50, notifyThresholdMinutes: cfg.notifyThresholdMinutes || 5, refreshInterval: cfg.refreshInterval || 30, notificationsEnabled: cfg.notificationsEnabled !== false };
});

handle('config:save', (cfg) => {
  if (cfg.host && !isValidHost(cfg.host)) {
    throw new Error('Invalid IP address or hostname.');
  }
  const existing = readConfig();
  const merged = { ...existing, ...cfg };
  // If password is an empty string on save, don't overwrite existing
  if (cfg.password === '') delete merged.password;
  writeConfig(merged);
  // Reset full session so next API call re-authenticates with new credentials
  session.sid = null;
  session.host = null;
  session.allowSelfSigned = false;
  return true;
});

handle('pihole:connect', async () => {
  await authenticate();
  return true;
});

handle('pihole:stats', async () => {
  if (!session.sid) await authenticate();
  return apiFetch('/stats/summary');
});

handle('pihole:top-domains', async () => {
  if (!session.sid) await authenticate();
  return apiFetch('/stats/top_domains');
});

handle('pihole:top-clients', async () => {
  if (!session.sid) await authenticate();
  return apiFetch('/stats/top_clients');
});

handle('pihole:gravity', async () => {
  if (!session.sid) await authenticate();
  return apiFetch('/info/gravity');
});

handle('pihole:domains:list', async () => {
  if (!session.sid) await authenticate();
  // Fetch all domains; filtering is done client-side to avoid relying on
  // server-side search support which varies across Pi-hole v6 builds.
  return apiFetch('/domains');
});

handle('pihole:domains:add', async ({ domain, list }) => {
  if (!session.sid) await authenticate();
  if (!['allow', 'deny'].includes(list)) throw new Error('Invalid list type.');
  if (!domain || typeof domain !== 'string' || domain.length > 253 || !/^[a-zA-Z0-9.\-_]+$/.test(domain)) {
    throw new Error('Invalid domain name.');
  }
  return apiFetch(`/domains/${list}/exact/${encodeURIComponent(domain)}`, 'POST', { comment: 'Added via Pi-hole Desktop' });
});

handle('pihole:domains:remove', async ({ domain, list }) => {
  if (!session.sid) await authenticate();
  if (!['allow', 'deny'].includes(list)) throw new Error('Invalid list type.');
  if (!domain || typeof domain !== 'string' || domain.length > 253 || !/^[a-zA-Z0-9.\-_]+$/.test(domain)) {
    throw new Error('Invalid domain name.');
  }
  return apiFetch(`/domains/${list}/exact/${encodeURIComponent(domain)}`, 'DELETE');
});

handle('pihole:queries:log', async (cursor) => {
  if (!session.sid) await authenticate();
  const params = typeof cursor === 'number' ? `?cursor=${cursor}` : '';
  return apiFetch(`/queries${params}`);
});

// ─── Notification Monitor ─────────────────────────────────────────────────────

const knownClients = new Set();   // keyed by IP string
let notifyTimer = null;
const domainHits = new Map();     // domain string -> [timestamp, ...]
const notifyCooldowns = new Map();// key -> last-notified timestamp (10 min cooldown)

const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;

// Extract a stable string ID and a readable label from a Pi-hole v6 client value.
// In v6 q.client is an object { ip, name }; in older builds it may be a plain string.
function clientId(client) {
  if (!client) return null;
  if (typeof client === 'object') return client.ip || JSON.stringify(client);
  return String(client);
}

function clientLabel(client) {
  if (!client) return '?';
  if (typeof client === 'object') return client.name || client.ip || '?';
  return String(client);
}

// Return true and record the time if the cooldown for `key` has expired.
function checkCooldown(key) {
  const last = notifyCooldowns.get(key) ?? 0;
  if (Date.now() - last < NOTIFY_COOLDOWN_MS) return false;
  notifyCooldowns.set(key, Date.now());
  return true;
}

function startNotificationMonitor(config) {
  if (notifyTimer) clearInterval(notifyTimer);
  if (!config.host) return;

  const thresholdCount   = config.notifyThresholdCount   || 50;
  const thresholdMinutes = config.notifyThresholdMinutes || 5;

  notifyTimer = setInterval(async () => {
    if (!session.sid) return;
    // Re-read config each tick so the enabled toggle takes effect without restart
    const currentConfig = readConfig();
    if (currentConfig.notificationsEnabled === false) return;

    try {
      const result = await apiFetch(`/queries?from=${Math.floor(Date.now() / 1000) - thresholdMinutes * 60}`);
      const queries = result?.queries ?? [];
      const now = Date.now();
      const windowMs = thresholdMinutes * 60 * 1000;

      // Track domain query counts
      for (const q of queries) {
        const domain = typeof q.domain === 'string' ? q.domain : null;
        if (!domain) continue;
        if (!domainHits.has(domain)) domainHits.set(domain, []);
        domainHits.get(domain).push(now);
      }

      // Prune and check thresholds
      for (const [domain, times] of domainHits.entries()) {
        const recent = times.filter(t => now - t < windowMs);
        if (recent.length === 0) { domainHits.delete(domain); continue; }
        domainHits.set(domain, recent);
        if (recent.length >= thresholdCount && checkCooldown(`domain:${domain}`)) {
          notify(
            'Pi-hole: High Query Rate',
            `Domain ${domain} queried ${recent.length} times in ${thresholdMinutes} min`
          );
          domainHits.delete(domain);
        }
      }

      // Detect new clients
      for (const q of queries) {
        const id    = clientId(q.client);
        const label = clientLabel(q.client);
        if (!id) continue;
        if (!knownClients.has(id)) {
          if (knownClients.size > 0 && checkCooldown(`client:${id}`)) {
            notify('Pi-hole: New Device', `New device detected: ${label}`);
          }
          knownClients.add(id);
        }
      }
    } catch {
      // Silently ignore — session may have expired
    }
  }, 60_000);
}

function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow;

function createWindow() {
  app.setAppUserModelId('com.pihole.desktop');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'Pi-hole Desktop',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  createWindow();
  const config = readConfig();
  if (config.host) {
    authenticate()
      .then(() => startNotificationMonitor(config))
      .catch(() => {}); // renderer will handle the error state
  }
});

app.on('window-all-closed', () => {
  if (notifyTimer) clearInterval(notifyTimer);
  logout().finally(() => app.quit());
});
