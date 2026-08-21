/* ==========================================================================
   Public view. No authentication, no writes — read-only campus air quality.

   Air quality on a shared campus is arguably something residents should be
   able to see without an account, and it makes the demo far easier: no login
   on a projector.
   ========================================================================== */

const CFG = window.CONFIG;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (v, d = 1) => (v == null ? '—' : Number(v).toFixed(d));
const when = (iso) => iso ? new Date(iso).toLocaleString('en-GB',
  { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const pillFor = (s) => s === 'hazardous' ? 'pill--red'
  : s === 'warning' ? 'pill--amber'
  : s === 'offline' ? 'pill--grey' : 'pill--green';

async function api(path) {
  const res = await fetch(CFG.API_BASE + path);
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

function setFeed(cls, text) {
  const p = $('feed');
  p.className = 'pill ' + cls;
  p.textContent = text;
}

async function load() {
  let stations;
  try {
    stations = await api('/latest');
    setFeed('pill--green pill--live', 'Live');
  } catch {
    setFeed('pill--red', 'Unavailable');
    $('hero-note').textContent = 'The monitoring service is not responding right now.';
    return;
  }

  // The headline number is the campus maximum, not the mean. A single
  // hazardous station matters more than three clean ones averaging it away.
  const reporting = stations.filter((s) => s.aqi_score != null);
  const worst = reporting.sort((a, b) => b.aqi_score - a.aqi_score)[0];

  if (worst) {
    const status = worst.status || 'normal';
    $('hero-num').textContent = fmt(worst.aqi_score, 1);
    $('hero-num').className = 'hero__num v-' + status;
    $('hero-band').className = 'pill ' + pillFor(status);
    $('hero-band').textContent = status;
    $('hero-zone').textContent = `Highest at ${worst.zone_name}`;
  } else {
    $('hero-zone').textContent = 'No station is reporting yet';
    $('hero-band').textContent = 'awaiting data';
  }

  $('stations').innerHTML = stations.map((s) => {
    const status = s.status || 'offline';
    const accent = ['normal', 'warning', 'hazardous'].includes(status) ? ` card--${status}` : '';
    return `<div class="card${accent}">
      <div class="card__label">
        <span>${esc(s.code || 'Zone ' + s.zone_id)}</span>
        <span class="pill ${s.is_physical ? 'pill--blue' : 'pill--grey'}">
          ${s.is_physical ? 'Hardware' : 'Recorded'}</span>
      </div>
      <div class="card__value v-${status === 'offline' ? 'idle' : status}">
        ${s.aqi_score == null ? '—' : fmt(s.aqi_score, 1)}</div>
      <div class="card__foot">${esc(s.zone_name || '')} · ${ago(s.ts)}</div>
    </div>`;
  }).join('');

  await renderStationMap('leaflet-map', stations);

  try {
    const inc = await api('/incidents?open_only=true&limit=8');
    $('advisories').innerHTML = inc.length ? inc.map((i) => `
      <div class="incident-row">
        <span class="pill ${i.severity === 'critical' ? 'pill--red' : 'pill--amber'}">${esc(i.severity)}</span>
        <span>${esc(i.message)}</span>
        <span class="card__foot mono">${when(i.opened_at)}</span>
      </div>`).join('')
      : '<p class="empty">No active advisories. Campus air is within thresholds.</p>';
  } catch { /* advisories are optional */ }
}

function tick() {
  $('clock').textContent =
    new Date().toLocaleTimeString('en-GB', { hour12: false }) + ' ' + (CFG.TZ_LABEL || 'MYT');
}

document.addEventListener('DOMContentLoaded', () => {
  // Reuse the shared brand mark and theme toggle without the sidebar chrome.
  const mark = document.querySelector('.side__mark svg');
  if (mark) mark.innerHTML = ICONS.wind;
  const actions = document.querySelector('.masthead__actions');
  if (actions && !document.getElementById('theme-toggle')) {
    const btn = document.createElement('button');
    btn.id = 'theme-toggle';
    btn.className = 'icon-btn';
    btn.type = 'button';
    btn.addEventListener('click', toggleTheme);
    actions.insertBefore(btn, actions.firstChild);
    applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
  }

  tick();
  setInterval(tick, 1000);
  load();
  setInterval(load, CFG.POLL_MS || 30000);
});
