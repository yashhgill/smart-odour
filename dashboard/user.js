/* ==========================================================================
   Student portal logic. Shares the session cookie with the admin portal, so a
   user with the admin role can sign in to either — the server enforces what
   each role may actually do.
   ========================================================================== */

const CFG = window.CONFIG;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let me = null, zones = [], myZone = 1, histRows = [];
let firstRun = false;

async function api(path, opts = {}) {
  const res = await fetch(CFG.API_BASE + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(body?.error || res.status), { status: res.status, body });
  return body;
}

const fmt = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const svgNS = 'http://www.w3.org/2000/svg';
const el = (n, a = {}, t) => {
  const e = document.createElementNS(svgNS, n);
  for (const [k, v] of Object.entries(a)) e.setAttribute(k, v);
  if (t !== undefined) e.textContent = t;
  return e;
};
const when = (iso) => iso ? new Date(iso).toLocaleString('en-GB',
  { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const clock = (iso) => iso ? new Date(iso).toLocaleTimeString('en-GB',
  { hour: '2-digit', minute: '2-digit' }) : '—';
const pillFor = (s) => s === 'hazardous' ? 'pill--red' : s === 'warning' ? 'pill--amber'
  : s === 'offline' ? 'pill--grey' : 'pill--green';

/* ------------------------------------------------------------------ auth -- */

function showGate(show) {
  $('gate').classList.toggle('hidden', !show);
  $('app').classList.toggle('ready', !show);
}
function swapForm(w) {
  $('form-login').style.display = w === 'login' ? '' : 'none';
  $('form-register').style.display = w === 'login' ? 'none' : '';
  $('gate-sub').textContent = w === 'login' ? 'Student Portal' : 'Create Account';
}

async function attemptLogin() {
  const b = $('li-go'), m = $('li-msg');
  m.className = 'msg'; m.textContent = '';
  b.disabled = true; b.textContent = 'Signing in…';
  try {
    me = await api('/auth/login', { method: 'POST', body: JSON.stringify({
      email: $('li-email').value.trim(), password: $('li-pass').value }) });
    $('li-pass').value = '';
    await enterApp();
  } catch (err) {
    m.className = 'msg msg--err';
    m.textContent = err.body?.error || 'Sign in failed.';
  } finally { b.disabled = false; b.textContent = 'Sign in'; }
}

async function attemptRegister() {
  const b = $('rg-go'), m = $('rg-msg');
  m.className = 'msg'; m.textContent = '';
  b.disabled = true; b.textContent = 'Creating…';
  const pass = $('rg-pass').value;
  const code = $('rg-code').value.trim();
  if (pass.length < 12) {
    m.className = 'msg msg--err';
    m.textContent = `Password is ${pass.length} characters. It needs at least 12.`;
    b.disabled = false; b.textContent = firstRun ? 'Create admin account' : 'Create account';
    return;
  }
  if (!firstRun && !code) {
    m.className = 'msg msg--err';
    m.textContent = 'An invite code is required. Ask an administrator to issue one.';
    b.disabled = false; b.textContent = 'Create account';
    return;
  }

  try {
    // On a fresh deployment there is no admin to issue invites, so the first
    // account is created through bootstrap instead. That route seals itself
    // permanently once a single user exists.
    if (firstRun) {
      await api('/auth/bootstrap', { method: 'POST', body: JSON.stringify({
        full_name: $('rg-name').value.trim(),
        email: $('rg-email').value.trim(),
        password: pass,
      }) });
      firstRun = false;
      m.className = 'msg msg--ok';
      m.textContent = 'Administrator account created. Sign in with it now.';
      setTimeout(() => { $('li-email').value = $('rg-email').value.trim(); swapForm('login'); }, 1200);
      b.disabled = false; b.textContent = 'Create account';
      return;
    }

    await api('/auth/register', { method: 'POST', body: JSON.stringify({
      code: $('rg-code').value.trim(), full_name: $('rg-name').value.trim(),
      email: $('rg-email').value.trim(), password: $('rg-pass').value }) });
    m.className = 'msg msg--ok';
    m.textContent = 'Account created. Sign in with it now.';
    setTimeout(() => { $('li-email').value = $('rg-email').value.trim(); swapForm('login'); }, 1200);
  } catch (err) {
    m.className = 'msg msg--err';
    m.textContent = err.body?.error || 'Could not create the account.';
  } finally { b.disabled = false; b.textContent = 'Create account'; }
}

/* -------------------------------------------------------------- sections -- */

const TITLES = {
  home:    ['Campus Air Quality', 'Live tracking for UTeM Main Campus, Durian Tunggal'],
  map:     ['Campus Map & Advisories', 'Station positions and active advisories'],
  history: ['Air Quality History', 'Verified environmental records'],
  profile: ['Profile & Settings', 'Your identity and notification preferences'],
};

function goTo(sec) {
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.sec === sec));
  document.querySelectorAll('.section').forEach((s) => s.classList.toggle('on', s.dataset.sec === sec));
  $('page-title').textContent = TITLES[sec][0];
  $('page-sub').textContent = TITLES[sec][1];
  if (sec === 'map') loadMap();
  if (sec === 'profile') loadProfile();
}

/* ------------------------------------------------------------------ home -- */

async function loadHome() {
  try {
    const latest = await api('/latest');
    const mine = latest.find((r) => r.zone_id === myZone) || {};

    $('my-zone').textContent = mine.zone_name || '—';
    $('my-coords').textContent = mine.latitude != null
      ? `${Number(mine.latitude).toFixed(4)}° N, ${Number(mine.longitude).toFixed(4)}° E` : '—';

    const idx = mine.aqi_score;
    const status = mine.status || 'offline';
    $('live-idx').textContent = idx != null ? fmt(idx, 1) : 'Awaiting';
    $('live-idx').className = 'card__value v-' + (status === 'offline' ? 'idle' : status);
    $('live-sub').textContent = idx != null
      ? `${status} · updated ${clock(mine.ts)}`
      : 'this station has not reported yet';

    $('stream-state').textContent = mine.ts ? 'Live' : 'Awaiting';
    $('stream-state').className = 'pill ' + (mine.ts ? 'pill--green' : 'pill--grey');

    await drawStream();
  } catch {
    $('live-sub').textContent = 'could not reach the monitoring service';
  }
}

async function drawStream() {
  const svg = $('stream');
  svg.innerHTML = '';
  try {
    const rows = await api(`/readings?zone_id=${myZone}&hours=6&limit=400`);
    const pts = rows.filter((r) => r.aqi_score != null);
    $('stream-sub').textContent = pts.length
      ? `${pts.length} readings over the last 6 hours.`
      : 'No readings in the last 6 hours.';
    if (!pts.length) {
      svg.appendChild(el('text', { x: 20, y: 110, class: 'axis' },
        'No readings yet for this station.'));
      return;
    }
    lineChart(svg, pts, 760, 220);
  } catch {
    svg.appendChild(el('text', { x: 20, y: 110, class: 'axis' }, 'Could not load the stream.'));
  }
}

function lineChart(svg, pts, W, H) {
  const pad = 34;
  const xs = (i) => pad + (i / Math.max(1, pts.length - 1)) * (W - pad * 2);
  const ys = (v) => H - pad - (clamp(v, 0, 100) / 100) * (H - pad * 2);

  for (let v = 0; v <= 100; v += 25) {
    svg.appendChild(el('line', { x1: pad, y1: ys(v), x2: W - pad, y2: ys(v), class: 'gridline' }));
    svg.appendChild(el('text', { x: 6, y: ys(v) + 3, class: 'axis' }, String(v)));
  }
  for (const [lvl, label] of [[40, 'warning'], [65, 'hazardous']]) {
    svg.appendChild(el('line', { x1: pad, y1: ys(lvl), x2: W - pad, y2: ys(lvl), class: 'band' }));
    svg.appendChild(el('text', { x: W - pad + 2, y: ys(lvl) + 3, class: 'axis' }, label));
  }
  svg.appendChild(el('polyline', {
    points: pts.map((p, i) => `${xs(i)},${ys(p.aqi_score)}`).join(' '), class: 'line',
  }));
  svg.appendChild(el('text', { x: pad, y: H - 8, class: 'axis' }, when(pts[0].ts)));
  svg.appendChild(el('text', { x: W - pad, y: H - 8, class: 'axis', 'text-anchor': 'end' },
    when(pts[pts.length - 1].ts)));
}

/* ------------------------------------------------------------------- map -- */

async function loadMap() {
  const svg = $('map');
  const host = $('leaflet-map');
  try {
    const latest = await api('/latest');

    // Real tiles when the network allows; the drawn map is the safety net so
    // a dead CDN degrades the map rather than emptying the page.
    const rendered = await renderStationMap('leaflet-map', latest);
    if (rendered) {
      if (host) host.style.display = '';
      svg.style.display = 'none';
      await loadAdvisories();
      return;
    }
    if (host) host.style.display = 'none';
    svg.style.display = '';
    svg.innerHTML = '';
    const W = 620, H = 420, pad = 58;
    const lats = latest.map((z) => z.latitude), lons = latest.map((z) => z.longitude);
    let [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
    let [minLon, maxLon] = [Math.min(...lons), Math.max(...lons)];
    const pl = (maxLat - minLat) * 0.4 || 0.002, po = (maxLon - minLon) * 0.4 || 0.002;
    minLat -= pl; maxLat += pl; minLon -= po; maxLon += po;
    const to = (lat, lon) => ({
      x: pad + ((lon - minLon) / (maxLon - minLon)) * (W - pad * 2),
      y: pad + ((maxLat - lat) / (maxLat - minLat)) * (H - pad * 2),
    });

    for (let x = pad; x <= W - pad; x += 47) {
      svg.appendChild(el('line', { x1: x, y1: pad, x2: x, y2: H - pad, class: 'gridline' }));
    }
    for (let y = pad; y <= H - pad; y += 47) {
      svg.appendChild(el('line', { x1: pad, y1: y, x2: W - pad, y2: y, class: 'gridline' }));
    }
    svg.appendChild(el('text', { x: pad, y: pad - 14, class: 'zone-sub' }, 'N ↑'));

    for (const z of latest) {
      const p = to(z.latitude, z.longitude);
      const tone = z.status === 'hazardous' ? '#d93025'
                 : z.status === 'warning' ? '#f0a202'
                 : z.status === 'offline' ? '#98a2b3' : '#0f9d58';
      if (z.status === 'warning' || z.status === 'hazardous') {
        svg.appendChild(el('circle', { cx: p.x, cy: p.y, r: 12 + (z.aqi_score || 0) * 0.22,
          fill: tone, 'fill-opacity': 0.14 }));
      }
      svg.appendChild(el('circle', { cx: p.x, cy: p.y, r: z.is_physical ? 8 : 6,
        fill: z.is_physical ? tone : '#fff', stroke: tone, 'stroke-width': 2,
        'stroke-dasharray': z.is_physical ? '' : '3 2' }));
      const flip = p.x > W - 165;
      svg.appendChild(el('text', {
        x: flip ? p.x - 14 : p.x + 14, y: p.y - 1, class: 'zone-label',
        'text-anchor': flip ? 'end' : 'start',
      }, `${z.code} · ${z.aqi_score != null ? fmt(z.aqi_score, 0) : '—'}`));
      svg.appendChild(el('text', {
        x: flip ? p.x - 14 : p.x + 14, y: p.y + 12, class: 'zone-sub',
        'text-anchor': flip ? 'end' : 'start',
      }, z.zone_name.length > 24 ? z.zone_name.slice(0, 23) + '…' : z.zone_name));
    }

    await loadAdvisories();
  } catch {
    if (host) host.style.display = 'none';
    svg.style.display = '';
    svg.innerHTML = '';
    svg.appendChild(el('text', { x: 20, y: 210, class: 'axis' }, 'Could not load station data.'));
  }
}

async function loadAdvisories() {
  try {
    const inc = await api('/incidents?open_only=true&limit=10');
    $('advisories').innerHTML = inc.length ? inc.map((i) => `
      <div class="incident-row">
        <span class="pill ${i.severity === 'critical' ? 'pill--red' : 'pill--amber'}">${esc(i.severity)}</span>
        <span>${esc(i.message)}</span>
        <span class="card__foot mono">${when(i.opened_at)}</span>
      </div>`).join('') : '<p class="empty">No active advisories. Campus air is within thresholds.</p>';
  } catch { /* leave the previous list */ }
}

/* --------------------------------------------------------------- history -- */

async function runHistory() {
  const b = $('h-go');
  b.disabled = true; b.textContent = 'Querying…';
  try {
    histRows = await api(`/readings?zone_id=${$('h-zone').value}&hours=${$('h-hours').value}&limit=3000`);
    const pts = histRows.filter((r) => r.aqi_score != null);
    $('h-sub').textContent = `${pts.length} readings returned.`;

    const svg = $('hist');
    svg.innerHTML = '';
    if (pts.length) lineChart(svg, pts, 760, 240);
    else svg.appendChild(el('text', { x: 20, y: 120, class: 'axis' }, 'No readings in this window.'));

    // Daily peaks: the maximum matters far more than the mean for odour, because
    // a brief severe spike is what people actually complain about.
    const byDay = {};
    for (const r of pts) {
      const day = r.ts.slice(0, 10);
      if (!byDay[day] || r.aqi_score > byDay[day].aqi_score) byDay[day] = r;
      byDay[day].n = (byDay[day].n || 0) + 1;
    }
    const days = Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
    $('peaks').innerHTML = days.length ? days.map(([day, r]) => {
      const st = r.aqi_score >= 65 ? 'hazardous' : r.aqi_score >= 40 ? 'warning' : 'normal';
      return `<tr><td class="mono">${day}</td>
        <td class="mono">${fmt(r.aqi_score, 1)}</td>
        <td><span class="pill ${pillFor(st)}">${st}</span></td>
        <td class="mono">${fmt(r.mq6)}</td>
        <td class="mono">${r.n}</td></tr>`;
    }).join('') : '<tr><td colspan="5" class="empty">No data in this window.</td></tr>';
  } catch {
    $('h-sub').textContent = 'Query failed.';
  } finally { b.disabled = false; b.textContent = 'Query logs'; }
}

function exportCsv() {
  if (!histRows.length) { alert('Run a query first.'); return; }
  const cols = ['ts', 'aqi_score', 'mq5', 'mq6', 'mq7_1', 'mq7_2', 'temperature', 'humidity', 'source'];
  const csv = [cols.join(',')].concat(
    histRows.map((r) => cols.map((c) => r[c] ?? '').join(','))
  ).join('\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `odour_zone${$('h-zone').value}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* --------------------------------------------------------------- profile -- */

async function loadProfile() {
  try {
    const p = await api('/profile');
    $('pf-name').value = p.full_name || '';
    $('pf-email').value = p.email || '';
    $('pf-dash').checked = p.alert_prefs?.dashboard_warnings !== false;
    $('pf-tg').checked = !!p.alert_prefs?.telegram;
    $('pf-mail').checked = !!p.alert_prefs?.email;
  } catch { /* leave blank */ }
}

async function saveProfile() {
  const m = $('pf-msg');
  m.className = 'msg'; m.textContent = '';
  try {
    await api('/profile', { method: 'PATCH', body: JSON.stringify({
      full_name: $('pf-name').value.trim(),
      dashboard_warnings: $('pf-dash').checked,
      telegram: $('pf-tg').checked,
      email: $('pf-mail').checked,
    }) });
    m.className = 'msg msg--ok';
    m.textContent = 'Profile updated.';
    me.full_name = $('pf-name').value.trim();
    paintIdentity();
  } catch (err) {
    m.className = 'msg msg--err';
    m.textContent = err.body?.error || 'Could not save.';
  }
}

/* ---------------------------------------------------------------- report -- */

async function sendReport() {
  const b = $('rp-send'), m = $('rp-msg');
  m.className = 'msg'; m.textContent = '';
  b.disabled = true; b.textContent = 'Submitting…';
  try {
    await api('/odour-reports', { method: 'POST', body: JSON.stringify({
      zone_id: Number($('rp-zone').value),
      severity: $('rp-sev').value,
      description: $('rp-desc').value.trim(),
    }) });
    m.className = 'msg msg--ok';
    m.textContent = 'Report submitted. Facilities will review it.';
    $('rp-desc').value = '';
    setTimeout(() => $('modal').classList.remove('on'), 1400);
  } catch (err) {
    m.className = 'msg msg--err';
    m.textContent = err.body?.error || 'Could not submit the report.';
  } finally { b.disabled = false; b.textContent = 'Submit report'; }
}

/* ------------------------------------------------------------------ boot -- */

function paintIdentity() {
  const initials = (me.full_name || me.email || '?').trim().split(/\s+/)
    .slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  $('avatar').textContent = initials;
  $('who-name').textContent = me.full_name || me.email;
  $('who-role').textContent = me.role;
}

async function enterApp() {
  showGate(false);
  paintIdentity();
  zones = await api('/zones');
  const opts = zones.map((z) => `<option value="${z.id}">${esc(z.code)} — ${esc(z.name)}</option>`).join('');
  for (const id of ['zone-pick', 'h-zone', 'rp-zone']) $(id).innerHTML = opts;

  const saved = Number(localStorage.getItem('odour_zone'));
  if (zones.some((z) => z.id === saved)) myZone = saved;
  $('zone-pick').value = String(myZone);
  $('h-zone').value = String(myZone);
  $('rp-zone').value = String(myZone);

  await loadHome();
  setInterval(loadHome, CFG.POLL_MS || 30000);
}

async function boot() {
  decorateChrome('Student Portal');
  document.querySelectorAll('.nav button').forEach((b) =>
    b.addEventListener('click', () => goTo(b.dataset.sec)));
  $('li-go').addEventListener('click', attemptLogin);
  $('rg-go').addEventListener('click', attemptRegister);
  $('to-register').addEventListener('click', () => swapForm('register'));
  $('to-login').addEventListener('click', () => swapForm('login'));
  $('li-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptLogin(); });
  $('zone-pick').addEventListener('change', (e) => {
    myZone = Number(e.target.value);
    localStorage.setItem('odour_zone', String(myZone));
    loadHome();
  });
  $('h-go').addEventListener('click', runHistory);
  $('csv').addEventListener('click', exportCsv);
  $('pf-save').addEventListener('click', saveProfile);
  $('open-report').addEventListener('click', () => {
    $('rp-zone').value = String(myZone);
    $('modal').classList.add('on');
  });
  $('rp-cancel').addEventListener('click', () => $('modal').classList.remove('on'));
  $('rp-send').addEventListener('click', sendReport);
  $('logout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    location.reload();
  });

  try {
    me = await api('/auth/me');
    await enterApp();
    return;
  } catch { /* not signed in */ }

  showGate(true);

  try {
    const status = await api('/auth/status');
    if (!status.bootstrapped) {
      firstRun = true;
      swapForm('register');
      $('gate-sub').textContent = 'First-Time Setup';
      $('rg-code').closest('.field').style.display = 'none';
      $('rg-go').textContent = 'Create admin account';
      $('rg-msg').className = 'msg';
      $('rg-msg').textContent = 'No accounts exist yet. This first account becomes the administrator.';
      $('to-register').closest('.gate__switch').style.display = 'none';
    }
  } catch { /* leave the normal login form */ }
}

document.addEventListener('DOMContentLoaded', boot);
