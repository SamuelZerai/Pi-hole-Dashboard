'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let refreshTimer = null;
let refreshInterval = 30; // seconds
let connected = false;

// ─── Utilities ────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function fmt(n) {
  if (n == null || n === '') return '—';
  return Number(n).toLocaleString();
}

function pct(num, denom) {
  if (!denom) return '0%';
  return ((num / denom) * 100).toFixed(1) + '%';
}

function showBanner(msg) {
  $('banner-msg').textContent = msg;
  $('banner').classList.remove('hidden');
}

function hideBanner() {
  $('banner').classList.add('hidden');
}

function setStatus(state, text) {
  const dot = $('status-dot');
  dot.className = 'status-dot ' + state;
  $('status-text').textContent = text;
}

function showError(elementId, msg) {
  const el = $(elementId);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 6000);
}

// ─── Tab Navigation ───────────────────────────────────────────────────────────

let qlLoaded = false;

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('active');
      t.classList.add('hidden');
    });
    btn.classList.add('active');
    const section = $('tab-' + target);
    section.classList.remove('hidden');
    section.classList.add('active');

    if (target === 'querylog') {
      if (!qlLoaded) { qlLoaded = true; loadQueryLog(true); }
      if ($('ql-live').checked) startQlLive();
    } else {
      stopQlLive();
    }
  });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

async function loadDashboard() {
  const [statsRes, topDomainsRes, topClientsRes] = await Promise.all([
    window.pihole.getStats(),
    window.pihole.getTopDomains(),
    window.pihole.getTopClients()
  ]);

  if (!statsRes.ok) {
    setStatus('error', 'Error');
    showBanner('Failed to load stats: ' + statsRes.error);
    connected = false;
    return;
  }

  connected = true;
  hideBanner();
  setStatus('connected', 'Connected');

  const s = statsRes.data;
  const total = s?.queries?.total ?? 0;
  const blocked = s?.queries?.blocked ?? 0;

  $('stat-total').textContent = fmt(total);
  $('stat-blocked').textContent = fmt(blocked);
  $('stat-blocked-pct').textContent = pct(blocked, total) + ' blocked';

  // clients.active is the v6 field name; fall back to total if active is absent
  $('stat-clients').textContent = fmt(s?.clients?.active ?? s?.clients?.total ?? null);

  // gravity is included in the summary response in v6
  $('stat-gravity').textContent = fmt(s?.gravity?.domains_being_blocked ?? null);

  if (topDomainsRes.ok) {
    renderTopDomains(topDomainsRes.data);
  }

  if (topClientsRes.ok) {
    renderTopClients(topClientsRes.data);
  }

  $('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

// Normalise the various shapes Pi-hole v6 uses for top-domain / top-client lists
// into a flat array of [label, count] pairs.
//
// Observed formats:
//   v6 object: { "domain.com": 123, ... }
//   v6 array:  [{ name: "domain.com", count: 123 }, ...]
//              [{ domain: "...", count: N }, ...]
//              [{ ip: "...", name: "...", count: N }, ...]
//   v5 tuple:  [["domain.com", 123], ...]
function normalisePairs(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map(item => {
      if (Array.isArray(item)) return [String(item[0]), Number(item[1])];
      const label = item.name || item.domain || item.ip || '?';
      return [String(label), Number(item.count ?? 0)];
    });
  }
  // Plain object { "label": count }
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([k, v]) => [k, Number(v)]);
  }
  return [];
}

function renderTopDomains(data) {
  const tbody = $('table-top-domains').querySelector('tbody');
  // v6 puts blocked domains under data.blocked; fall back to top-level or queries list
  const raw = data?.blocked ?? data?.top_queries ?? data?.domains ?? data;
  const pairs = normalisePairs(raw);
  if (!pairs.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="muted">No data</td></tr>';
    return;
  }
  tbody.innerHTML = pairs.slice(0, 10).map(([domain, count]) =>
    `<tr><td>${escHtml(domain)}</td><td>${fmt(count)}</td></tr>`
  ).join('');
}

function renderTopClients(data) {
  const tbody = $('table-top-clients').querySelector('tbody');
  // v6 uses data.sources; v5 used data.top_sources
  const raw = data?.sources ?? data?.top_sources ?? data?.clients ?? data;
  const pairs = normalisePairs(raw);
  if (!pairs.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="muted">No data</td></tr>';
    return;
  }
  tbody.innerHTML = pairs.slice(0, 10).map(([client, count]) =>
    `<tr><td>${escHtml(client)}</td><td>${fmt(count)}</td></tr>`
  ).join('');
}

$('btn-refresh').addEventListener('click', () => loadDashboard());

// ─── Auto-refresh ─────────────────────────────────────────────────────────────

function startAutoRefresh(intervalSec) {
  stopAutoRefresh();
  refreshInterval = intervalSec || 30;
  refreshTimer = setInterval(() => {
    if (connected) loadDashboard();
  }, refreshInterval * 1000);
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// ─── Domain Management ────────────────────────────────────────────────────────

// Pi-hole v6 may return type as an integer (0=allow exact,1=allow regex,
// 2=deny exact,3=deny regex) or as a string ("allow"/"deny").
function domainListType(d) {
  const t = d.type;
  if (t === 'allow' || t === 0 || t === 1) return 'allow';
  if (t === 'deny'  || t === 2 || t === 3) return 'deny';
  // Fallback: check if a separate "kind" or "list" field is present
  if (d.list === 'whitelist' || d.list === 0) return 'allow';
  return 'deny';
}

let allDomains = []; // cache of last-fetched domain list

async function searchDomains(query) {
  // Only fetch from API when the cache is empty (first load or after add/remove)
  if (!allDomains.length) {
    const res = await window.pihole.listDomains();
    if (!res.ok) {
      showError('domains-error', 'Failed to load domains: ' + res.error);
      return;
    }
    // Handle multiple possible response shapes
    allDomains = res.data?.domains ?? res.data?.data ?? res.data ?? [];
  }
  renderDomainTable(allDomains, query);
}

function renderDomainTable(items, query) {
  const tbody = $('table-domains').querySelector('tbody');

  // Client-side filtering
  const q = (query || '').trim().toLowerCase();
  const filtered = q ? items.filter(d => (d.domain ?? '').toLowerCase().includes(q)) : items;

  if (!filtered.length) {
    const msg = q ? `No domains matching "${escHtml(q)}".` : 'No domains found. Add one above.';
    tbody.innerHTML = `<tr><td colspan="4" class="muted">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(d => {
    const listType  = domainListType(d);
    const badgeClass = listType === 'allow' ? 'badge-allow' : 'badge-deny';
    const badgeLabel = listType === 'allow' ? 'Allowlist' : 'Blocklist';
    return `<tr>
      <td>${escHtml(d.domain)}</td>
      <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
      <td class="muted">${escHtml(d.comment || '')}</td>
      <td><button class="btn-remove" data-domain="${escAttr(d.domain)}" data-list="${escAttr(listType)}">Remove</button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => removeDomain(btn.dataset.domain, btn.dataset.list));
  });
}

async function addDomain(domain, list) {
  if (!domain.trim()) return;
  const res = await window.pihole.addDomain(domain.trim(), list);
  if (!res.ok) {
    showError('domains-error', 'Failed to add domain: ' + res.error);
    return;
  }
  $('domain-input').value = '';
  allDomains = []; // invalidate cache
  await searchDomains($('domain-search').value);
}

async function removeDomain(domain, list) {
  const res = await window.pihole.removeDomain(domain, list);
  if (!res.ok) {
    showError('domains-error', 'Failed to remove domain: ' + res.error);
    return;
  }
  allDomains = []; // invalidate cache
  await searchDomains($('domain-search').value);
}

$('btn-search').addEventListener('click', () => searchDomains($('domain-search').value));
$('domain-search').addEventListener('keydown', e => { if (e.key === 'Enter') searchDomains(e.target.value); });
$('btn-add-allow').addEventListener('click', () => addDomain($('domain-input').value, 'allow'));
$('btn-add-block').addEventListener('click', () => addDomain($('domain-input').value, 'deny'));

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const res = await window.pihole.readConfig();
  if (!res.ok) return;
  const cfg = res.data;
  $('cfg-protocol').value = cfg.protocol || 'http';
  $('cfg-host').value = cfg.host || '';
  $('cfg-refresh').value = cfg.refreshInterval || 30;
  $('cfg-notify-count').value = cfg.notifyThresholdCount || 50;
  $('cfg-notify-minutes').value = cfg.notifyThresholdMinutes || 5;
  $('cfg-self-signed').checked = cfg.allowSelfSigned || false;
  $('cfg-notify-enabled').checked = cfg.notificationsEnabled !== false;
  $('password-hint').textContent = cfg.hasPassword ? 'Password is saved. Leave blank to keep it.' : '';
}

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('settings-status');
  status.textContent = 'Saving…';
  status.className = 'settings-status';

  const cfg = {
    protocol: $('cfg-protocol').value,
    host: $('cfg-host').value.trim(),
    password: $('cfg-password').value,
    refreshInterval: parseInt($('cfg-refresh').value, 10),
    notifyThresholdCount: parseInt($('cfg-notify-count').value, 10),
    notifyThresholdMinutes: parseInt($('cfg-notify-minutes').value, 10),
    allowSelfSigned: $('cfg-self-signed').checked,
    notificationsEnabled: $('cfg-notify-enabled').checked
  };

  const saveRes = await window.pihole.saveConfig(cfg);
  if (!saveRes.ok) {
    status.textContent = 'Error: ' + saveRes.error;
    status.className = 'settings-status err';
    return;
  }

  const connectRes = await window.pihole.connect();
  if (!connectRes.ok) {
    status.textContent = 'Saved but connection failed: ' + connectRes.error;
    status.className = 'settings-status err';
    setStatus('error', 'Connection failed');
    connected = false;
    return;
  }

  status.textContent = 'Connected successfully!';
  status.className = 'settings-status ok';
  connected = true;
  setStatus('connected', 'Connected');

  startAutoRefresh(cfg.refreshInterval);
  $('cfg-password').value = '';
  $('password-hint').textContent = 'Password is saved. Leave blank to keep it.';

  // Switch to dashboard and load
  document.querySelector('.nav-btn[data-tab="dashboard"]').click();
  loadDashboard();
});

// ─── Query Log ────────────────────────────────────────────────────────────────

const QL_STATUS_LABELS = {
  // Pi-hole v6 integer status codes → human label + CSS class
  1:  { label: 'Blocked (gravity)',    cls: 'ql-blocked' },
  2:  { label: 'Allowed (forwarded)',  cls: 'ql-allowed' },
  3:  { label: 'Allowed (cache)',      cls: 'ql-cached'  },
  4:  { label: 'Blocked (regex)',      cls: 'ql-blocked' },
  5:  { label: 'Blocked (blacklist)',  cls: 'ql-blocked' },
  6:  { label: 'Blocked (upstream)',   cls: 'ql-blocked' },
  7:  { label: 'Allowed (cache)',      cls: 'ql-cached'  },
  8:  { label: 'Blocked (CNAME)',      cls: 'ql-blocked' },
  9:  { label: 'Allowed (retried)',    cls: 'ql-allowed' },
  10: { label: 'Allowed (ignored)',    cls: 'ql-allowed' },
  11: { label: 'Blocked (denylist)',   cls: 'ql-blocked' },
  12: { label: 'Blocked (special)',    cls: 'ql-blocked' },
  13: { label: 'Allowed (forwarded)',  cls: 'ql-allowed' },
  14: { label: 'Allowed (gravity)',    cls: 'ql-allowed' },
  15: { label: 'Allowed (denylist)',   cls: 'ql-allowed' },
  // String fallbacks used by some v6 builds
  GRAVITY:   { label: 'Blocked (gravity)', cls: 'ql-blocked' },
  FORWARDED: { label: 'Allowed',           cls: 'ql-allowed' },
  CACHE:     { label: 'Cached',            cls: 'ql-cached'  },
  BLOCKED:   { label: 'Blocked',           cls: 'ql-blocked' },
  ALLOWED:   { label: 'Allowed',           cls: 'ql-allowed' },
};

let qlRows = [];          // all fetched rows
let qlLiveTimer = null;
let qlCursor = null;      // pagination cursor

function qlStatusInfo(status) {
  const s = QL_STATUS_LABELS[status] ?? QL_STATUS_LABELS[String(status).toUpperCase()];
  if (s) return s;
  const str = String(status ?? '').toLowerCase();
  if (str.includes('block')) return { label: 'Blocked', cls: 'ql-blocked' };
  if (str.includes('cache')) return { label: 'Cached',  cls: 'ql-cached'  };
  return { label: str || '?', cls: 'ql-allowed' };
}

function qlClientLabel(q) {
  // client may be an object {ip, name} or a plain string
  if (!q.client) return '?';
  if (typeof q.client === 'string') return q.client;
  return q.client.name || q.client.ip || '?';
}

function qlMatchesFilters(q) {
  const fc = $('ql-filter-client').value.trim().toLowerCase();
  const fd = $('ql-filter-domain').value.trim().toLowerCase();
  const fs = $('ql-filter-status').value;
  if (fc && !qlClientLabel(q).toLowerCase().includes(fc)) return false;
  if (fd && !(q.domain ?? '').toLowerCase().includes(fd)) return false;
  if (fs) {
    const { cls } = qlStatusInfo(q.status);
    if (!cls.includes(fs)) return false;
  }
  return true;
}

function renderQueryLog() {
  const filtered = qlRows.filter(qlMatchesFilters);
  $('ql-count').textContent = `${filtered.length.toLocaleString()} queries${qlRows.length !== filtered.length ? ` (filtered from ${qlRows.length.toLocaleString()})` : ''}`;

  const tbody = $('table-querylog').querySelector('tbody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">No queries.</td></tr>';
    return;
  }

  // Show newest first, cap at 500 rows for performance
  tbody.innerHTML = filtered.slice(-500).reverse().map(q => {
    const ts = q.time ? new Date(q.time * 1000).toLocaleTimeString() : '?';
    const client = escHtml(qlClientLabel(q));
    const domain = escHtml(q.domain ?? '?');
    const type   = escHtml(q.type ?? '?');
    const { label, cls } = qlStatusInfo(q.status);
    return `<tr>
      <td class="ql-time">${ts}</td>
      <td>${client}</td>
      <td class="ql-domain">${domain}</td>
      <td class="ql-type">${type}</td>
      <td><span class="ql-status ${cls}">${escHtml(label)}</span></td>
    </tr>`;
  }).join('');
}

async function loadQueryLog(reset = false) {
  if (!connected) return;
  if (reset) { qlRows = []; qlCursor = null; }

  const res = await window.pihole.getQueryLog(qlCursor ?? undefined);
  if (!res.ok) return;

  const incoming = res.data?.queries ?? res.data?.data ?? [];
  qlCursor = res.data?.cursor ?? null;

  if (reset) {
    qlRows = incoming;
  } else {
    // Append only new rows (avoid duplicates if cursor is not supported)
    const existingIds = new Set(qlRows.map(r => r.id));
    qlRows = qlRows.concat(incoming.filter(r => !existingIds.has(r.id)));
  }

  renderQueryLog();
}

function startQlLive() {
  stopQlLive();
  qlLiveTimer = setInterval(() => {
    if (connected && $('ql-live').checked) loadQueryLog();
  }, 5000);
}

function stopQlLive() {
  if (qlLiveTimer) { clearInterval(qlLiveTimer); qlLiveTimer = null; }
}

$('btn-ql-refresh').addEventListener('click', () => loadQueryLog(true));

$('ql-live').addEventListener('change', e => {
  if (e.target.checked) startQlLive(); else stopQlLive();
});

$('btn-ql-clear').addEventListener('click', () => {
  $('ql-filter-client').value = '';
  $('ql-filter-domain').value = '';
  $('ql-filter-status').value = '';
  renderQueryLog();
});

['ql-filter-client', 'ql-filter-domain', 'ql-filter-status'].forEach(id => {
  $(id).addEventListener('input', renderQueryLog);
});

// ─── XSS-safe helpers ─────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Banner dismiss ───────────────────────────────────────────────────────────

$('banner-dismiss').addEventListener('click', hideBanner);

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await loadSettings();

  const cfg = (await window.pihole.readConfig()).data ?? {};
  if (cfg.host) {
    setStatus('disconnected', 'Connecting…');
    const res = await window.pihole.connect();
    if (res.ok) {
      connected = true;
      setStatus('connected', 'Connected');
      startAutoRefresh(cfg.refreshInterval || 30);
      loadDashboard();
    } else {
      setStatus('error', 'Connection failed');
      showBanner('Could not connect to Pi-hole: ' + res.error + ' — check Settings.');
    }
  } else {
    setStatus('disconnected', 'Not configured');
    showBanner('Pi-hole is not configured yet. Go to Settings to get started.');
    document.querySelector('.nav-btn[data-tab="settings"]').click();
  }
}

init();
