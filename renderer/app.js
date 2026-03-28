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
  });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

async function loadDashboard() {
  const [statsRes, topDomainsRes, topClientsRes, gravityRes] = await Promise.all([
    window.pihole.getStats(),
    window.pihole.getTopDomains(),
    window.pihole.getTopClients(),
    window.pihole.getGravity()
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
  $('stat-clients').textContent = fmt(s?.clients?.unique ?? '—');

  if (gravityRes.ok) {
    const g = gravityRes.data;
    $('stat-gravity').textContent = fmt(g?.gravity?.domains_being_blocked ?? g?.domains_being_blocked ?? '—');
  }

  if (topDomainsRes.ok) {
    renderTopDomains(topDomainsRes.data);
  }

  if (topClientsRes.ok) {
    renderTopClients(topClientsRes.data);
  }

  $('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

function renderTopDomains(data) {
  const tbody = $('table-top-domains').querySelector('tbody');
  const domains = data?.top_queries ?? data?.domains ?? [];
  if (!domains.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="muted">No data</td></tr>';
    return;
  }
  tbody.innerHTML = domains.slice(0, 10).map(([domain, count]) =>
    `<tr><td>${escHtml(domain)}</td><td>${fmt(count)}</td></tr>`
  ).join('');
}

function renderTopClients(data) {
  const tbody = $('table-top-clients').querySelector('tbody');
  const clients = data?.top_sources ?? data?.clients ?? [];
  if (!clients.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="muted">No data</td></tr>';
    return;
  }
  tbody.innerHTML = clients.slice(0, 10).map(([client, count]) =>
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

async function searchDomains(query) {
  const res = await window.pihole.listDomains(query);
  if (!res.ok) {
    showError('domains-error', 'Search failed: ' + res.error);
    return;
  }
  renderDomainTable(res.data);
}

function renderDomainTable(data) {
  const tbody = $('table-domains').querySelector('tbody');
  const items = data?.domains ?? [];
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">No domains found.</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(d => {
    const listType = d.type === 'allow' ? 'allow' : 'deny';
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
  await searchDomains($('domain-search').value);
}

async function removeDomain(domain, list) {
  const res = await window.pihole.removeDomain(domain, list);
  if (!res.ok) {
    showError('domains-error', 'Failed to remove domain: ' + res.error);
    return;
  }
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
    allowSelfSigned: $('cfg-self-signed').checked
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
