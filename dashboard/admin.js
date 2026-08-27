/* ==========================================================================
   Admin portal logic.

   Session auth uses an HttpOnly cookie, so every request must set
   credentials:'include'. The cookie is invisible to this script by design —
   that is what stops an XSS from stealing it.
   ========================================================================== */

const CFG = window.CONFIG;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let me = null;
let zones = [];
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

const fmt = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
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

const pillFor = (status) => status === 'hazardous' ? 'pill--red'
  : status === 'warning' ? 'pill--amber'
  : status === 'offline' ? 'pill--grey' : 'pill--green';

/* -------------------------------------------------------------------------- */
/*  Login gate                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Shown when a signed-in user lacks the role for this portal. Deliberately
 * names the role they hold — "access denied" with no explanation just
 * generates a support message.
 */
function showDenied() {
  showGate(true);
  const card = document.querySelector('.gate__card');
  card.innerHTML = `
    <div class="gate__brand">
      <img class="gate__logo" src="assets/logo-light-full.png" alt="Smart Odour">
      <p>Admin Portal</p>
    </div>
    <p class="msg msg--err" style="text-align:center;margin-bottom:6px">
      This account does not have administrator access.
    </p>
    <p class="card__foot" style="text-align:center;margin-bottom:18px">
      You are signed in as <b>${esc(me.email || '')}</b> with the
      <b>${esc(me.role)}</b> role. Threshold calibration and user management
      require the <b>admin</b> or <b>facility</b> role.
    </p>
    <a class="btn btn--wide" href="user.html">Go to the User Portal</a>
    <p class="gate__switch"><a id="denied-logout">Sign in as someone else</a></p>`;
  swapLogoArt(document.documentElement.getAttribute('data-theme') || 'light');
  document.getElementById('denied-logout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    location.reload();
  });
}

function showGate(show) {
  $('gate').classList.toggle('hidden', !show);
  $('app').classList.toggle('ready', !show);
}

async function attemptLogin() {
  const btn = $('li-go'), msg = $('li-msg');
  msg.className = 'msg';
  msg.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    me = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('li-email').value.trim(), password: $('li-pass').value }),
    });
    $('li-pass').value = '';
    await enterApp();
  } catch (err) {
    msg.className = 'msg msg--err';
    // 429 is the lockout; show the server's own wording, it names the wait.
    msg.textContent = err.body?.error || 'Sign in failed.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

async function attemptRegister() {
  const btn = $('rg-go'), msg = $('rg-msg');
  msg.className = 'msg';
  msg.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Creating…';

  const pass = $('rg-pass').value;
  const code = $('rg-code').value.trim();
  const reset = () => {
    btn.disabled = false;
    btn.textContent = firstRun ? 'Create admin account' : 'Create account';
  };

  // Catch the obvious mistakes here rather than spending a round trip on them.
  if (pass.length < 12) {
    msg.className = 'msg msg--err';
    msg.textContent = `Password is ${pass.length} characters. It needs at least 12.`;
    reset();
    return;
  }
  if (!firstRun && !code) {
    msg.className = 'msg msg--err';
    msg.textContent = 'An invite code is required. Ask an administrator to issue one.';
    reset();
    return;
  }

  try {
    // On a fresh deployment nobody exists to issue invites, so the first
    // account goes through bootstrap. That route seals itself permanently
    // the moment a single user exists.
    if (firstRun) {
      await api('/auth/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          full_name: $('rg-name').value.trim(),
          email: $('rg-email').value.trim(),
          password: pass,
        }),
      });
      firstRun = false;
      msg.className = 'msg msg--ok';
      msg.textContent = 'Administrator account created. Sign in with it now.';
      setTimeout(() => {
        $('li-email').value = $('rg-email').value.trim();
        swapForm('login');
      }, 1200);
      reset();
      return;
    }

    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        code,
        full_name: $('rg-name').value.trim(),
        email: $('rg-email').value.trim(),
        password: pass,
      }),
    });
    msg.className = 'msg msg--ok';
    msg.textContent = 'Account created. Sign in with it now.';
    setTimeout(() => {
      $('li-email').value = $('rg-email').value.trim();
      swapForm('login');
    }, 1200);
  } catch (err) {
    msg.className = 'msg msg--err';
    msg.textContent = err.body?.error || 'Could not create the account.';
  } finally {
    reset();
  }
}

function swapForm(which) {
  $('form-login').style.display = which === 'login' ? '' : 'none';
  $('form-register').style.display = which === 'login' ? 'none' : '';
  $('gate-sub').textContent = which === 'login' ? 'Admin Portal' : 'Create Account';
}

/* -------------------------------------------------------------------------- */
/*  Sections                                                                   */
/* -------------------------------------------------------------------------- */

const TITLES = {
  home:   ['Admin Dashboard', 'Live station telemetry across the campus network'],
  data:   ['Historical Data & Reports', 'Query recorded readings and export compliance documents'],
  ai:     ['Predictive Odour Forecasting', 'Trajectory modelling from live sensor and weather inputs'],
  alerts: ['System Alerts & Safety Thresholds', 'Calibration limits and the incident trail'],
  system: ['System Health & User Management', 'Infrastructure status and access control'],
};

function goTo(sec) {
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.sec === sec));
  document.querySelectorAll('.section').forEach((s) => s.classList.toggle('on', s.dataset.sec === sec));
  $('page-title').textContent = TITLES[sec][0];
  $('page-sub').textContent = TITLES[sec][1];

  if (sec === 'ai')     { loadForecast(); }
  if (sec === 'alerts') { loadThresholds(); loadIncidents(); }
  if (sec === 'system') { loadSystem(); }
}

/* ------------------------------------------------------------------- home -- */

async function loadHome() {
  try {
    const [z, latest] = await Promise.all([api('/zones'), api('/latest')]);
    zones = z;


    $('node-state').textContent = live
      ? `Reporting (${physicalZone ? physicalZone.code : 'Zone ?'})`
      : physicalZone ? `Offline — last seen ${ago(physicalZone.ts)}` : 'Awaiting hardware';
    const nodeSub = $('node-sub');
    if (nodeSub && physicalZone) nodeSub.textContent =
      `Raw 12-bit ADC values (0–4095) from the physical node at ${physicalZone.zone_name}.`;
    $('node-state').className = 'pill ' + (live ? 'pill--green' : 'pill--grey');

    // Physical zone follows the database flag — set automatically by ingest
    // when the ESP32 posts. No hardcoding.
    const physicalZone = latest.find((r) => r.is_physical);
    const node = physicalZone || {};
    const live = physicalZone && physicalZone.ts &&
                 (Date.now() - new Date(physicalZone.ts).getTime()) < 60 * 60 * 1000;

    const worst = latest
      .filter((r) => r.aqi_score !== null && r.aqi_score !== undefined)
      .sort((a, b) => b.aqi_score - a.aqi_score)[0];

    $('home-cards').innerHTML = `
      ${card('Highest odour index', worst ? fmt(worst.aqi_score, 1) : '—',
             worst ? `${esc(worst.zone_name)} · ${worst.status}` : 'no readings',
             worst ? worst.status : 'idle')}
      ${card('Stations reporting', `${latest.filter((r) => r.ts).length} / ${latest.length}`,
             physicalZone ? `${esc(physicalZone.code)} is hardware` : 'no hardware yet', 'idle')}
      ${card(physicalZone ? `Node · ${esc(physicalZone.code)}` : 'Node', live ? 'Online' : 'Offline', live ? ago(node.ts) : 'no telemetry received',
             live ? 'normal' : 'idle')}
      ${card('Campus mean', latest.filter((r) => r.aqi_score != null).length
             ? fmt(latest.filter((r) => r.aqi_score != null)
                 .reduce((a, r) => a + r.aqi_score, 0)
               / latest.filter((r) => r.aqi_score != null).length, 1) : '—',
             'across reporting stations', 'idle')}`;

    $('node-cards').innerHTML = `
      ${card('Temperature', node.temperature != null ? fmt(node.temperature, 1) + ' °C' : '--.- °C', 'DHT11', 'idle')}
      ${card('Humidity', node.humidity != null ? fmt(node.humidity, 0) + ' %' : '--.- %', 'DHT11', 'idle')}
      ${card('MQ-5 (LPG/Gas)', node.mq5 != null ? fmt(node.mq5) : '---- ', 'ADC', 'idle')}
      ${card('MQ-6 (Butane)', node.mq6 != null ? fmt(node.mq6) : '---- ', 'ADC', 'idle')}
      ${card('MQ-7 #1 (CO)', node.mq7_1 != null ? fmt(node.mq7_1) : '---- ', 'ADC', 'idle')}
      ${card('MQ-7 #2 (CO)', node.mq7_2 != null ? fmt(node.mq7_2) : '---- ', 'ADC', 'idle')}`;

    const sub = $('stations-sub');
    if (sub) sub.textContent = physicalZone
      ? `${physicalZone.code} (${physicalZone.zone_name}) is the active hardware node. Other zones replay recorded data.`
      : 'No hardware node detected yet. Waiting for first live reading.';

    $('zones-body').innerHTML = latest.map((r) => `
      <tr>
        <td><strong>${esc(r.code || r.zone_id)}</strong><br>
            <span class="card__foot">${esc(r.zone_name)}</span></td>
        <td><span class="pill ${r.is_physical ? 'pill--green' : 'pill--grey'}">
            ${r.is_physical ? 'Hardware' : 'Replay'}</span></td>
        <td class="mono">${r.aqi_score != null ? fmt(r.aqi_score, 1) : '—'}</td>
        <td><span class="pill ${pillFor(r.status)}">${esc(r.status)}</span></td>
        <td class="mono">${r.mq6 != null ? fmt(r.mq6) : '—'}</td>
        <td class="card__foot">${ago(r.ts)}</td>
      </tr>`).join('');

    const sel = $('q-zone');
    if (sel && !sel.options.length) {
      sel.innerHTML = zones.map((z) =>
        `<option value="${z.id}">${esc(z.code)} — ${esc(z.name)}</option>`).join('');
    }
  } catch {
    $('home-cards').innerHTML = `<div class="card"><div class="card__label">Connection</div>
      <div class="card__value v-hazardous" style="font-size:18px">Unreachable</div>
      <div class="card__foot">The API did not respond.</div></div>`;
  }
}

function card(label, value, foot, tone = 'idle') {
  const accent = ['normal', 'warning', 'hazardous'].includes(tone) ? ` card--${tone}` : '';
  return `<div class="card${accent}">
    <div class="card__label"><span>${esc(label)}</span></div>
    <div class="card__value v-${tone}">${esc(value)}</div>
    <div class="card__foot">${esc(foot)}</div></div>`;
}

/* ------------------------------------------------------------------- data -- */

async function runQuery() {
  const btn = $('q-go');
  btn.disabled = true;
  btn.textContent = 'Querying…';
  try {
    const rows = await api(`/readings?zone_id=${$('q-zone').value}&hours=${$('q-hours').value}&limit=500`);
    $('q-count').textContent = `${rows.length} readings returned (most recent 500).`;
    $('q-body').innerHTML = rows.length
      ? rows.slice().reverse().map((r) => `<tr>
          <td class="mono">${when(r.ts)}</td>
          <td class="mono">${fmt(r.aqi_score, 1)}</td>
          <td class="mono">${fmt(r.mq5)}</td>
          <td class="mono">${fmt(r.mq6)}</td>
          <td class="mono">${fmt(r.mq7_1)}</td>
          <td class="mono">${fmt(r.mq7_2)}</td>
          <td class="mono">${r.temperature != null ? fmt(r.temperature, 1) : '—'}</td>
          <td class="mono">${r.humidity != null ? fmt(r.humidity) : '—'}</td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">No readings in this window.</td></tr>';
  } catch {
    $('q-body').innerHTML = '<tr><td colspan="8" class="empty">Query failed.</td></tr>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Query logs';
  }
}

/* --------------------------------------------------------------- forecast -- */

const svgNS = 'http://www.w3.org/2000/svg';
const svgEl = (n, a = {}, t) => {
  const e = document.createElementNS(svgNS, n);
  for (const [k, v] of Object.entries(a)) e.setAttribute(k, v);
  if (t !== undefined) e.textContent = t;
  return e;
};
const clamp01 = (v) => Math.min(100, Math.max(0, v));

async function loadForecast() {
  const sel = $('ai-zone');
  if (!sel.options.length && zones.length) {
    sel.innerHTML = zones.map((z) =>
      `<option value="${z.id}">${esc(z.code)} — ${esc(z.name)}</option>`).join('');
    sel.addEventListener('change', loadForecast);
  }
  const zoneId = sel.value || 1;

  let f;
  try {
    f = await api(`/predict?zone_id=${zoneId}`);
  } catch {
    $('ai-cards').innerHTML = card('Forecast service', 'Unreachable',
      'the API did not respond', 'hazardous');
    return;
  }

  const run = f.last_run;
  const runAge = run?.started_at ? ago(run.started_at) : 'never';

  if (!f.available) {
    // Say why, rather than rendering an empty chart that looks broken.
    $('ai-cards').innerHTML = `
      ${card('Model', 'Not fitted', f.reason || 'no forecast yet', 'idle')}
      ${card('Last run', runAge, run ? `${run.zones_fitted || 0} zones fitted` : 'the forecaster has not run', 'idle')}
      ${card('Forecast window', '—', 'next 3 hours once fitted', 'idle')}`;
    $('ai-sub').textContent = f.reason || 'No forecast available for this station.';
    $('ai-chart').innerHTML = '';
    $('ai-chart').appendChild(svgEl('text', { x: 24, y: 125, class: 'axis' },
      f.reason || 'No forecast available.'));
    $('ai-features').innerHTML = '<p class="empty">No model fitted yet.</p>';
    $('ai-table').innerHTML = '<tr><td colspan="4" class="empty">No forecast available.</td></tr>';
    renderRuns(run);
    return;
  }

  const modelLabel = f.model === 'random_forest' ? 'Random Forest'
                   : f.model === 'linear_trend' ? 'Linear trend' : f.model;
  // R^2 is on a chronological hold-out split, so it is a fair read on
  // generalisation rather than a number inflated by shuffling the series.
  const quality = f.r2 == null ? 'not scored'
                : f.r2 >= 0.7 ? 'strong fit'
                : f.r2 >= 0.4 ? 'moderate fit' : 'weak fit';

  $('ai-cards').innerHTML = `
    ${card('Algorithm', modelLabel, `${(f.n_samples || 0).toLocaleString()} samples`, 'idle')}
    ${card('Fit quality (R²)', f.r2 == null ? '—' : f.r2.toFixed(3), quality,
           f.r2 >= 0.7 ? 'normal' : f.r2 >= 0.4 ? 'warning' : 'idle')}
    ${card('Peak forecast', fmt(Math.max(...f.points.map((p) => p.predicted)), 1),
           'next 3 hours',
           Math.max(...f.points.map((p) => p.predicted)) >= 65 ? 'hazardous'
             : Math.max(...f.points.map((p) => p.predicted)) >= 40 ? 'warning' : 'normal')}
    ${card('Last fitted', runAge, `computed on the sidecar`, 'idle')}`;

  $('ai-sub').textContent =
    `${modelLabel} fitted on ${(f.n_samples || 0).toLocaleString()} readings, generated ${ago(f.generated_at)}.`;

  drawForecast(f);

  const feats = Object.entries(f.features || {}).sort((a, b) => b[1] - a[1]);
  $('ai-features').innerHTML = feats.length ? feats.map(([name, w]) => {
    const pct = Math.round(Math.abs(w) * 100);
    return `<div style="margin-bottom:9px">
      <div style="display:flex;justify-content:space-between;font-size:12.5px">
        <span>${esc(name)}</span><span class="mono">${w.toFixed(3)}</span></div>
      <div style="height:6px;background:#eef1f5;border-radius:3px;margin-top:4px">
        <div style="height:100%;width:${Math.min(100, pct)}%;background:var(--blue);border-radius:3px"></div>
      </div></div>`;
  }).join('') : '<p class="empty">This model does not expose feature weights.</p>';

  $('ai-table').innerHTML = f.points.map((p) => {
    const st = p.predicted >= 65 ? 'hazardous' : p.predicted >= 40 ? 'warning' : 'normal';
    return `<tr><td class="mono">+${p.horizon_min} min</td>
      <td class="mono">${fmt(p.predicted, 1)}</td>
      <td class="mono">${fmt(p.lower, 1)} – ${fmt(p.upper, 1)}</td>
      <td><span class="pill ${pillFor(st)}">${st}</span></td></tr>`;
  }).join('');

  renderRuns(run);
}

function renderRuns(run) {
  $('ai-runs').innerHTML = run ? `
    <table><tbody>
      <tr><td>Last run</td><td class="mono">${when(run.started_at)}</td></tr>
      <tr><td>Result</td><td><span class="pill ${run.ok ? 'pill--green' : 'pill--amber'}">
        ${run.ok ? 'success' : 'no zones fitted'}</span></td></tr>
      <tr><td>Zones fitted</td><td class="mono">${run.zones_fitted ?? 0}</td></tr>
      <tr><td>Duration</td><td class="mono">${run.duration_ms ?? '—'} ms</td></tr>
      ${run.detail ? `<tr><td>Notes</td><td class="card__foot">${esc(run.detail)}</td></tr>` : ''}
    </tbody></table>` : '<p class="empty">No runs recorded yet.</p>';
}

function drawForecast(f) {
  const svg = $('ai-chart');
  svg.innerHTML = '';
  const W = 760, H = 250, pad = 40;
  const pts = f.points;
  const xs = (i) => pad + (i / Math.max(1, pts.length - 1)) * (W - pad * 2);
  const ys = (v) => H - pad - (clamp01(v) / 100) * (H - pad * 2);

  for (let v = 0; v <= 100; v += 25) {
    svg.appendChild(svgEl('line', { x1: pad, y1: ys(v), x2: W - pad, y2: ys(v), class: 'gridline' }));
    svg.appendChild(svgEl('text', { x: 10, y: ys(v) + 3, class: 'axis' }, String(v)));
  }
  for (const [lvl, label] of [[40, 'warning'], [65, 'hazardous']]) {
    svg.appendChild(svgEl('line', { x1: pad, y1: ys(lvl), x2: W - pad, y2: ys(lvl), class: 'band' }));
    svg.appendChild(svgEl('text', { x: W - pad + 3, y: ys(lvl) + 3, class: 'axis' }, label));
  }

  // Uncertainty band first, so the central line sits on top of it.
  const upper = pts.map((p, i) => `${xs(i)},${ys(p.upper ?? p.predicted)}`).join(' ');
  const lower = pts.map((p, i) => `${xs(i)},${ys(p.lower ?? p.predicted)}`).reverse().join(' ');
  svg.appendChild(svgEl('polygon', {
    points: `${upper} ${lower}`, fill: 'var(--blue)', 'fill-opacity': '0.12',
  }));
  svg.appendChild(svgEl('polyline', {
    points: pts.map((p, i) => `${xs(i)},${ys(p.predicted)}`).join(' '), class: 'line',
  }));

  pts.forEach((p, i) => {
    svg.appendChild(svgEl('circle', { cx: xs(i), cy: ys(p.predicted), r: 4,
      fill: 'var(--blue)' }));
    svg.appendChild(svgEl('text', { x: xs(i), y: H - 12, class: 'axis',
      'text-anchor': 'middle' }, `+${p.horizon_min}m`));
    svg.appendChild(svgEl('text', { x: xs(i), y: ys(p.predicted) - 12, class: 'axis',
      'text-anchor': 'middle' }, fmt(p.predicted, 1)));
  });
}

/* -------------------------------------------------------------------- ESG -- */

async function generateEsg() {
  const btn = $('esg-go'), msg = $('esg-msg');
  const days = $('esg-days').value;
  msg.className = 'msg';
  msg.textContent = 'Compiling. The reporting service may take a minute if it has been idle.';
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    // Streams a PDF rather than JSON, so it bypasses api() and takes the blob.
    const res = await fetch(`${CFG.API_BASE}/reports/esg?days=${days}`, {
      method: 'POST', credentials: 'include',
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { detail = (await res.json()).error || detail; } catch { /* keep status */ }
      throw new Error(detail);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ESG_Odour_Report_${days}d.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    msg.className = 'msg msg--ok';
    msg.textContent = 'Report downloaded and archived.';
    loadReports();
  } catch (err) {
    msg.className = 'msg msg--err';
    msg.textContent = err.message || 'Could not generate the report.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate PDF';
  }
}

async function loadReports() {
  try {
    const rows = await api('/reports?limit=8');
    $('reports-list').innerHTML = rows.length
      ? rows.map((r) => `<div style="padding:7px 0;border-bottom:1px solid var(--line);font-size:13px">
          <span class="mono">${when(r.generated_at)}</span> — ${esc(r.title)}
          <span class="card__foot">${esc(r.r2_key || '')}</span></div>`).join('')
      : '<p class="empty">No reports generated yet.</p>';
    $('reports-list').className = rows.length ? '' : 'empty';
  } catch { /* optional */ }
}

/* ----------------------------------------------------------------- alerts -- */

const SENSORS = [
  ['mq5', 'Sensor MQ-5 (LPG / Gas)'],
  ['mq6', 'Sensor MQ-6 (LPG / Butane)'],
  ['mq7_1', 'Sensor MQ-7 #1 (Carbon Monoxide)'],
  ['mq7_2', 'Sensor MQ-7 #2 (Carbon Monoxide)'],
];

async function loadThresholds() {
  try {
    const t = await api('/thresholds');
    $('thr-state').textContent = 'Synced';
    $('thr-state').className = 'pill pill--green';
    $('thr-form').innerHTML = SENSORS.map(([key, label]) => `
      <div class="thr">
        <div class="thr__title">${esc(label)}</div>
        <div class="field"><label>Warning limit (ADC)</label>
          <input type="number" min="0" max="4095" id="thr-${key}-w" value="${t[key].warning}"></div>
        <div class="field"><label>Critical limit (ADC)</label>
          <input type="number" min="0" max="4095" id="thr-${key}-c" value="${t[key].critical}"></div>
      </div>`).join('');
  } catch {
    $('thr-state').textContent = 'Unavailable';
    $('thr-state').className = 'pill pill--red';
  }
}

async function saveThresholds() {
  const msg = $('thr-msg');
  msg.className = 'msg';
  msg.textContent = '';
  const payload = {};
  for (const [key] of SENSORS) {
    payload[key] = {
      warning: Number($(`thr-${key}-w`).value),
      critical: Number($(`thr-${key}-c`).value),
    };
  }
  try {
    await api('/thresholds', { method: 'PUT', body: JSON.stringify(payload) });
    msg.className = 'msg msg--ok';
    msg.textContent = 'Calibration applied.';
  } catch (err) {
    msg.className = 'msg msg--err';
    msg.textContent = err.status === 403
      ? 'Only an admin can change calibration limits.'
      : (err.body?.error || 'Could not save.');
  }
}

async function loadIncidents() {
  try {
    const rows = await api('/incidents?open_only=false&limit=40');
    const open = rows.filter((i) => !i.resolved_at);
    $('alert-cards').innerHTML = `
      ${card('Unresolved incidents', String(open.length),
             open.length ? 'require attention' : 'all stations secure',
             open.length ? 'warning' : 'normal')}
      ${card('Critical open', String(open.filter((i) => i.severity === 'critical').length),
             'severity: critical', open.some((i) => i.severity === 'critical') ? 'hazardous' : 'normal')}
      ${card('Total logged', String(rows.length), 'across all time', 'idle')}`;

    $('inc-body').innerHTML = rows.length ? rows.map((i) => {
      const state = i.resolved_at ? 'Resolved' : i.acknowledged_at ? 'Acknowledged' : 'Open';
      const tone = i.severity === 'critical' ? 'pill--red'
                 : i.severity === 'warning' ? 'pill--amber' : 'pill--grey';
      return `<tr>
        <td class="mono">${when(i.opened_at)}</td>
        <td>${esc(i.kind)}</td>
        <td><span class="pill ${tone}">${esc(i.severity)}</span></td>
        <td>${esc(i.message)}</td>
        <td>${state}</td>
        <td>${i.resolved_at ? '' :
          `<button class="btn btn--ghost" data-ack="${esc(i.id)}"
             data-verb="${i.acknowledged_at ? 'resolve' : 'acknowledge'}">
             ${i.acknowledged_at ? 'Resolve' : 'Acknowledge'}</button>`}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">No incidents recorded.</td></tr>';

    document.querySelectorAll('[data-ack]').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await api(`/incidents/${b.dataset.ack}/${b.dataset.verb}`, { method: 'PATCH' });
          await loadIncidents();
        } catch { b.disabled = false; b.textContent = 'Failed'; }
      });
    });
  } catch { /* leave the previous list */ }
}

/* ----------------------------------------------------------------- system -- */

async function loadSystem() {
  try {
    const [uptime, latest] = await Promise.all([api('/uptime'), api('/latest')]);
    const s = (uptime.summary || [])[0] || {};
    $('sys-cards').innerHTML = `
      ${card('Database', s.uptime_pct != null ? fmt(s.uptime_pct, 2) + ' %' : '—',
             'observed over 24h', s.uptime_pct >= 99.5 ? 'normal' : 'warning')}
      ${card('Probe latency', s.avg_latency_ms != null ? Math.round(s.avg_latency_ms) + ' ms' : '—',
             'cron health check', 'idle')}
      ${card('Edge nodes online', `${latest.filter((r) => r.ts).length} / ${latest.length}`,
             'UTeM campus', 'idle')}
      ${card('Raw archive', 'R2 active', 'every payload archived', 'normal')}`;
  } catch { /* non-fatal */ }

  if (me?.role === 'admin') {
    try {
      const users = await api('/users');
      $('users-body').innerHTML = users.map((u) => `<tr>
        <td>${esc(u.email)}</td><td>${esc(u.full_name || '—')}</td>
        <td><span class="pill ${u.role === 'admin' ? 'pill--green' : 'pill--grey'}">${esc(u.role)}</span></td>
        <td class="mono">${when(u.created_at)}</td></tr>`).join('');
    } catch { /* ignore */ }

    try {
      const invites = await api('/invites');
      $('invites-body').innerHTML = invites.length ? invites.map((i) => `<tr>
        <td class="mono">${esc(i.code)}</td><td>${esc(i.role)}</td>
        <td class="mono">${when(i.expires_at)}</td>
        <td><span class="pill ${i.used_at ? 'pill--grey' : 'pill--green'}">
            ${i.used_at ? 'Used' : 'Unused'}</span></td></tr>`).join('')
        : '<tr><td colspan="4" class="empty">No invites issued.</td></tr>';
    } catch { /* ignore */ }
  } else {
    $('users-body').innerHTML = '<tr><td colspan="4" class="empty">Admin role required.</td></tr>';
    $('mk-invite').style.display = 'none';
  }
}

async function makeInvite() {
  const msg = $('invite-msg');
  msg.className = 'msg';
  try {
    const inv = await api('/auth/invite', { method: 'POST', body: JSON.stringify({ role: 'viewer' }) });
    msg.className = 'msg msg--ok';
    msg.textContent = `Invite code: ${inv.code} — valid 72 hours, single use.`;
    await loadSystem();
  } catch (err) {
    msg.className = 'msg msg--err';
    msg.textContent = err.body?.error || 'Could not create an invite.';
  }
}

/* -------------------------------------------------------------------------- */
/*  Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function enterApp() {
  // The server refuses privileged routes regardless, but rendering an admin
  // console to a viewer and letting every panel fail is a poor answer. Refuse
  // at the door and send them somewhere they can actually use.
  if (!['admin', 'facility'].includes(me.role)) {
    showDenied();
    return;
  }

  showGate(false);
  setRole(me.role, 'Admin Portal');
  const initials = (me.full_name || me.email || '?').trim().split(/\s+/)
    .slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  $('avatar').textContent = initials;
  $('who-name').textContent = me.full_name || me.email;
  $('who-role').textContent = me.role;
  await loadHome();
  setInterval(loadHome, CFG.POLL_MS || 30000);
}

async function boot() {
  decorateChrome('Admin Portal');
  document.querySelectorAll('.nav button').forEach((b) =>
    b.addEventListener('click', () => goTo(b.dataset.sec)));
  $('li-go').addEventListener('click', attemptLogin);
  $('rg-go').addEventListener('click', attemptRegister);
  $('to-register').addEventListener('click', () => swapForm('register'));
  $('to-login').addEventListener('click', () => swapForm('login'));
  $('li-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptLogin(); });
  $('q-go').addEventListener('click', runQuery);
  $('thr-save').addEventListener('click', saveThresholds);
  $('thr-reset').addEventListener('click', loadThresholds);
  $('mk-invite').addEventListener('click', makeInvite);
  $('esg-go').addEventListener('click', generateEsg);
  $('logout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    location.reload();
  });

  // Already signed in? The cookie answers that, not this script.
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
