'use strict';

const { app, BrowserWindow, ipcMain, Notification, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (raw.passwordEncrypted && safeStorage.isEncryptionAvailable()) {
      raw.password = safeStorage.decryptString(Buffer.from(raw.passwordEncrypted, 'base64'));
      delete raw.passwordEncrypted;
    }
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

async function authenticate() {
  const config = readConfig();
  if (!config.host) throw new Error('No Pi-hole host configured.');
  if (!config.password) throw new Error('No password configured.');

  session.host = config.host;
  session.protocol = config.protocol || 'http';
  session.allowSelfSigned = config.allowSelfSigned || false;

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
  return { host: cfg.host || '', protocol: cfg.protocol || 'http', allowSelfSigned: cfg.allowSelfSigned || false, hasPassword: !!cfg.password, notifyThresholdCount: cfg.notifyThresholdCount || 50, notifyThresholdMinutes: cfg.notifyThresholdMinutes || 5, refreshInterval: cfg.refreshInterval || 30 };
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

handle('pihole:domains:list', async (query) => {
  if (!session.sid) await authenticate();
  const q = query ? `?search=${encodeURIComponent(query)}` : '';
  return apiFetch(`/domains${q}`);
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

const knownClients = new Set();
let notifyTimer = null;
const domainHits = new Map(); // domain -> [{timestamp}]

function startNotificationMonitor(config) {
  if (notifyTimer) clearInterval(notifyTimer);
  if (!config.host) return;

  const thresholdCount = config.notifyThresholdCount || 50;
  const thresholdMinutes = config.notifyThresholdMinutes || 5;

  notifyTimer = setInterval(async () => {
    if (!session.sid) return;
    try {
      const result = await apiFetch(`/queries?from=${Math.floor(Date.now() / 1000) - thresholdMinutes * 60}`);
      const queries = result?.queries ?? [];
      const now = Date.now();
      const windowMs = thresholdMinutes * 60 * 1000;

      // Track domain query counts
      for (const q of queries) {
        const domain = q.domain;
        if (!domainHits.has(domain)) domainHits.set(domain, []);
        domainHits.get(domain).push(now);
      }

      // Prune old entries and check thresholds
      for (const [domain, times] of domainHits.entries()) {
        const recent = times.filter(t => now - t < windowMs);
        if (recent.length === 0) { domainHits.delete(domain); continue; }
        domainHits.set(domain, recent);
        if (recent.length >= thresholdCount) {
          notify(
            'Pi-hole: High Query Rate',
            `"${domain}" was queried ${recent.length} times in ${thresholdMinutes} min`
          );
          domainHits.delete(domain); // remove entry to avoid repeat alerts and prevent unbounded growth
        }
      }

      // Detect new clients
      for (const q of queries) {
        const client = q.client;
        if (client && !knownClients.has(client)) {
          if (knownClients.size > 0) {
            // Only alert after first population
            notify('Pi-hole: New Device', `Unknown device detected: ${client}`);
          }
          knownClients.add(client);
        }
      }
    } catch {
      // Silently ignore monitor errors — session may have expired
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
  app.quit();
});
