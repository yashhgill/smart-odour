$('#mk').innerHTML = LOGO; themeButton($('#theme'));
if (C.DEMO) $('#demo').innerHTML = '<div class="demo noprint">Demonstration with simulated data. Sign in with admin@example.com / demo</div>';
const app = $('#app');
let data = null, tab = 'report';
const iso = d => new Date(d).toISOString();
const dayInput = d => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
const klStart = s => s + 'T00:00:00+08:00';
const klEnd = s => new Date(new Date(s + 'T00:00:00+08:00').getTime() + 864e5).toISOString();

function showLogin(msg = '') {
  $('#out').hidden = true;
  app.innerHTML = `<form class="card login" id="f"><img class="logo l logo-big" src="assets/logo-light-full.png" alt="Smart Odour Monitoring Platform"><img class="logo d logo-big" src="assets/logo-dark-full.png" alt="Smart Odour Monitoring Platform"><h1>Admin sign in</h1>
    <label>Email<input id="em" type="email" autocomplete="username" required></label>
    <label>Password<input id="pw" type="password" autocomplete="current-password" required></label>
    <button class="btn primary">Sign in</button><div class="note err" role="alert">${esc(msg)}</div></form>`;
  $('#f').onsubmit = async ev => {
    ev.preventDefault();
    if (C.DEMO_DATA) return $('#em').value === 'admin@example.com' && $('#pw').value === 'demo' ? (sessionStorage.setItem('odour_token', 'demo'), boot()) : showLogin('Wrong email or password.');
    const r = await fetch(`${C.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: C.SUPABASE_KEY },
      body: JSON.stringify({ email: $('#em').value, password: $('#pw').value }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) return showLogin('Wrong email or password.');
    try { sessionStorage.setItem('odour_token', b.access_token); } catch {}
    boot();
  };
}
async function boot() {
  if (C.DEMO_DATA && !token()) return showLogin();
  try { data = await rpc('admin_overview', {}, true); }
  catch (e) { return showLogin(e.status === 403 ? 'This account is not an admin.' : ''); }
  $('#out').hidden = false; render();
}
$('#out').onclick = () => { try { sessionStorage.removeItem('odour_token'); } catch {} showLogin(); };

function render() {
  const tabs = [['report', 'Reports'], ['locations', 'Locations and devices'], ['calibrate', 'Calibration'], ['reliability', 'Reliability'], ['alerts', 'Alerts']];
  app.innerHTML = `<nav class="tabs noprint">${tabs.map(([k, l]) => `<button data-t="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav><div id="view" style="display:grid;gap:14px"></div>`;
  app.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.t; render(); });
  ({ report, locations, calibrate, reliability, alerts })[tab]();
}
const locOpts = (sel, all) => (all ? '<option value="">All locations</option>' : '') + data.locations.map(l => `<option value="${l.id}" ${sel === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
const num = v => v === '' || v == null ? null : Number(v);
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
const csv = rows => rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');

// ---------- report: how often, when, how long. Prints to PDF from the browser.
async function report() {
  const v = $('#view'), now = Date.now();
  v.innerHTML = `<section class="card noprint"><div class="row">
    <label>From<input type="date" id="a" value="${dayInput(now - 30 * 864e5)}"></label><label>To<input type="date" id="b" value="${dayInput(now)}"></label>
    <label>Location<select id="l">${locOpts(null, true)}</select></label>
    <span style="flex:1"></span><button class="btn" id="cev">Events CSV</button><button class="btn" id="crd">Readings CSV</button><button class="btn primary" id="pr">Print or save PDF</button></div></section><div id="rep" style="display:grid;gap:14px"></div>`;
  const go = async () => {
    const f = klStart($('#a').value), t = klEnd($('#b').value), l = num($('#l').value);
    const days = Math.max(1, Math.round((new Date(t) - new Date(f)) / 864e5));
    const [s, ev, hr] = await Promise.all([rpc('get_summary', { p_from: f, p_to: t, p_location: l }), rpc('get_events', { p_from: f, p_to: t, p_location: l, p_limit: 500 }), rpc('get_hourly', { p_location: l, p_days: days })]);
    const name = l ? data.locations.find(x => x.id === l).name : 'All locations';
    const top = [...hr].sort((a, b) => (Number(b.noticeable_min) + Number(b.strong_min)) - (Number(a.noticeable_min) + Number(a.strong_min)))[0];
    $('#rep').innerHTML = `<section class="card"><h1>Odour report: ${esc(name)}</h1><div class="sub" style="margin:4px 0 14px">${esc($('#a').value)} to ${esc($('#b').value)}. Malaysia time.</div>
      <div class="kpis">${[[s.events, 'odour events'], [s.strong_events, 'reached strong'], [`${s.days_with_odour} / ${days}`, 'days affected'], [s.total_minutes, 'minutes in total']].map(([a, b]) => `<div class="kpi"><b>${esc(a)}</b><span>${b}</span></div>`).join('')}</div>
      <p>${s.events ? `The system recorded ${s.events} odour events over ${days} days, averaging ${s.avg_minutes} minutes each. Odour was most frequent around ${hourLabel(top.hour)}.` : 'No odour events were recorded in this period.'}</p></section>
      <section class="card"><div class="head"><h2>Minutes of odour by hour of day</h2><span class="legend"><span><i style="background:var(--noticeable)"></i>Noticeable</span><span><i style="background:var(--strong)"></i>Strong</span></span></div><div id="rh"></div></section>
      <section class="card"><h2 style="margin-bottom:8px">By location</h2><table><thead><tr><th>Location</th><th class="num">Events</th><th class="num">Strong</th><th class="num">Minutes</th></tr></thead><tbody>${s.by_location.map(x => `<tr><td>${esc(x.location)}</td><td class="num">${x.events}</td><td class="num">${x.strong}</td><td class="num">${x.minutes}</td></tr>`).join('') || '<tr><td colspan="4">No events</td></tr>'}</tbody></table></section>
      <section class="card"><h2 style="margin-bottom:8px">All events</h2><div class="tscroll"><table><thead><tr><th>Location</th><th>Date</th><th>From</th><th>To</th><th class="num">Minutes</th><th class="num">Peak index</th><th>Level</th></tr></thead><tbody>${ev.map(e => `<tr><td>${esc(e.location)}</td><td>${fmtDate(e.started_at)}</td><td>${fmtTime(e.started_at)}</td><td>${e.ended_at ? fmtTime(e.ended_at) : 'Ongoing'}</td><td class="num">${e.minutes}</td><td class="num">${e.peak_index}</td><td>${e.strong ? 'Strong' : 'Noticeable'}</td></tr>`).join('') || '<tr><td colspan="7">No events</td></tr>'}</tbody></table></div></section>`;
    hoursChart($('#rh'), hr);
    $('#cev').onclick = () => download('odour-events.csv', csv([['location', 'started_at', 'ended_at', 'minutes', 'peak_index', 'strong'], ...ev.map(e => [e.location, e.started_at, e.ended_at, e.minutes, e.peak_index, e.strong])]));
    $('#crd').onclick = async () => {
      if (!l) return alert('Choose one location to export its readings.');
      const rows = await rpc('admin_readings', { p_location: l, p_from: f, p_to: t }, true);
      download('odour-readings.csv', csv([['device', 'recorded_at', 'index', 'level', 'r1', 'r2', 'r3', 'r4', 'temperature', 'humidity', 'replayed'], ...rows.map(r => [r.device_id, r.recorded_at, r.odour_index, r.level, r.r1, r.r2, r.r3, r.r4, r.temperature, r.humidity, r.replayed])]));
    };
  };
  ['#a', '#b', '#l'].forEach(s => $(s).onchange = go); $('#pr').onclick = () => window.print();
  await go();
}
// ---------- locations and devices
function locations() {
  $('#view').innerHTML = `<section class="card"><div class="head"><h2>Map positions</h2><label>Location to move<select id="pl" aria-label="Location to move">${locOpts()}</select></label></div>
    <div class="note" id="pmsg">Choose a location, then click its true spot on the map. It saves straight away.</div><div id="pick"></div></section>
    <div class="grid1-1"><section class="card"><div class="head"><h2>Locations</h2></div>
    <div class="tscroll"><table><thead><tr><th>Name</th><th>Type</th><th>Shown</th><th>Test mode</th><th></th></tr></thead><tbody>${data.locations.map(l => `<tr><td>${esc(l.name)}</td><td>${esc(l.kind)}</td><td>${l.active ? 'Yes' : 'No'}</td><td><button class="btn" data-test="${l.id}" title="Use while the sensor is not at this location yet. The site labels it and sends no public alerts.">${l.test_mode ? 'On, turn off' : 'Off, turn on'}</button>${l.test_mode ? ` <button class="btn" data-clear="${l.id}">Clear test readings</button>` : ''}</td><td class="num"><button class="btn" data-tog="${l.id}">${l.active ? 'Hide' : 'Show'}</button></td></tr>`).join('')}</tbody></table></div>
    <form class="row" id="nl" style="margin-top:12px"><input id="nn" placeholder="New location" required aria-label="New location name"><select id="nk" aria-label="Type"><option value="residence">Residence</option><option value="farm">Farm</option><option value="other">Other</option></select><button class="btn primary">Add</button></form></section>
    <section class="card"><div class="head"><h2>Devices</h2></div>
    <div class="tscroll"><table><thead><tr><th>Device</th><th>Placed at</th><th>Last seen</th><th class="num">Signal</th><th class="num">Queued</th><th></th></tr></thead><tbody>${data.devices.map(d => `<tr><td>${esc(d.id)}<br><span class="sub">${esc(d.firmware || '')}</span></td><td><select data-mv="${esc(d.id)}" aria-label="Location of ${esc(d.id)}">${locOpts(d.location_id)}</select></td><td>${d.last_seen ? fmtDate(d.last_seen) + ' ' + fmtTime(d.last_seen) : 'Never'}</td><td class="num">${d.rssi ?? '–'}</td><td class="num">${d.queued ?? '–'}</td><td class="num"><button class="btn" data-rot="${esc(d.id)}">New key</button> <button class="btn" data-cmd="${esc(d.id)}|relearn">Re-learn</button> <button class="btn" data-cmd="${esc(d.id)}|restart">Restart</button>${d.pending_command ? `<br><span class="sub">${esc(d.pending_command)} sent, waiting for the sensor</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="6">No devices yet</td></tr>'}</tbody></table></div>
    <form class="row" id="nd" style="margin-top:12px"><input id="di" placeholder="NODE-1" required aria-label="Device name"><select id="dl" aria-label="Location">${locOpts()}</select><button class="btn primary">Add device</button></form>
    <div id="keybox" style="margin-top:10px"></div></section></div>`;
  placePicker();
  const showKey = r => { $('#keybox').innerHTML = `<div class="note">Put this key in <b>secrets.h</b> as DEVICE_KEY for ${esc(r.id)}. It is shown only once.</div><div class="key">${esc(r.key)}</div>`; };
  const refresh = async () => { data = await rpc('admin_overview', {}, true); };
  $('#nl').onsubmit = async e => { e.preventDefault(); await rpc('admin_save_location', { p_id: null, p_name: $('#nn').value, p_kind: $('#nk').value, p_active: true }, true); await refresh(); render(); };
  $('#nd').onsubmit = async e => { e.preventDefault(); const r = await rpc('admin_save_device', { p_id: $('#di').value.trim(), p_location: Number($('#dl').value) }, true); await refresh(); render(); showKey(r); };
  app.querySelectorAll('[data-tog]').forEach(b => b.onclick = async () => { const l = data.locations.find(x => x.id === Number(b.dataset.tog)); await rpc('admin_save_location', { p_id: l.id, p_name: l.name, p_kind: l.kind, p_active: !l.active }, true); await refresh(); render(); });
  app.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => { const l = data.locations.find(x => x.id === Number(b.dataset.test)); await rpc('admin_set_test_mode', { p_location: l.id, p_on: !l.test_mode }, true); await refresh(); render(); });
  app.querySelectorAll('[data-clear]').forEach(b => b.onclick = async () => { const l = data.locations.find(x => x.id === Number(b.dataset.clear)); if (!confirm(`Delete all readings and events for ${l.name}? This cannot be undone.`)) return; const n = await rpc('admin_clear_test_data', { p_location: l.id }, true); alert(`Deleted ${n} readings.`); });
  app.querySelectorAll('[data-cmd]').forEach(b => b.onclick = async () => { const [id, cmd] = b.dataset.cmd.split('|'); const ask = cmd === 'relearn' ? `Make ${id} learn clean air again? It shows no levels for 24 hours. Do this once it is at its real location.` : `Restart ${id}? It warms up again for 5 minutes.`; if (!confirm(ask)) return; await rpc('admin_send_command', { p_device: id, p_command: cmd }, true); await refresh(); render(); });
  app.querySelectorAll('[data-mv]').forEach(s => s.onchange = async () => { await rpc('admin_save_device', { p_id: s.dataset.mv, p_location: Number(s.value) }, true); await refresh(); render(); });
  app.querySelectorAll('[data-rot]').forEach(b => b.onclick = async () => { const d = data.devices.find(x => x.id === b.dataset.rot); if (!confirm(`Create a new key for ${d.id}? The node stops sending until it is updated.`)) return; showKey(await rpc('admin_save_device', { p_id: d.id, p_location: d.location_id, p_rotate: true }, true)); });
}
// Click the map to put the chosen location's pin on its real spot.
function placePicker() {
  if (!window.L) return;
  const placed = data.locations.filter(l => l.lat != null);
  const m = L.map('pick', { scrollWheelZoom: false });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery &copy; Esri and contributors' }).addTo(m);
  if (placed.length) m.fitBounds(placed.map(l => [l.lat, l.lng]), { padding: [60, 60] }); else m.setView([2.3125, 102.32], 15);
  const icon = l => L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="pin"><b>${l.id}</b><span>${esc(l.name)}</span></div>` });
  const marks = {};
  placed.forEach(l => { marks[l.id] = L.marker([l.lat, l.lng], { icon: icon(l) }).addTo(m); });
  m.on('click', async e => {
    const l = data.locations.find(x => x.id === Number($('#pl').value)), { lat, lng } = e.latlng;
    await rpc('admin_save_location', { p_id: l.id, p_name: l.name, p_kind: l.kind, p_active: l.active, p_lat: lat, p_lng: lng }, true);
    l.lat = lat; l.lng = lng;
    if (marks[l.id]) marks[l.id].setLatLng(e.latlng); else marks[l.id] = L.marker(e.latlng, { icon: icon(l) }).addTo(m);
    $('#pmsg').textContent = `${l.name} moved to ${lat.toFixed(5)}, ${lng.toFixed(5)}.`;
  });
}
// ---------- calibration: which readings are good and which are bad
async function calibrate() {
  const c = await rpc('admin_calibration', { p_days: 90 }, true), s = data.settings;
  const enough = c.pairs >= 30 && c.no_smell >= 5 && (c.noticeable + c.strong) >= 5;
  $('#view').innerHTML = `<section class="card"><div class="head"><h2>What counts as normal, noticeable and strong</h2><span class="sub">${s.calibrated_at ? 'Calibrated ' + fmtDate(s.calibrated_at) : 'Provisional thresholds'}</span></div>
    <p class="note">Each smell report from the public page is paired with the sensor index at that moment. The suggested thresholds are the values that best separate what people smelled from what they did not.</p>
    <div class="kpis"><div class="kpi"><b>${c.pairs}</b><span>reports matched to readings</span></div><div class="kpi"><b>${c.avg_index?.[0] ?? '–'}</b><span>average index: no smell (${c.no_smell})</span></div><div class="kpi"><b>${c.avg_index?.[1] ?? '–'}</b><span>average index: noticeable (${c.noticeable})</span></div><div class="kpi"><b>${c.avg_index?.[2] ?? '–'}</b><span>average index: strong (${c.strong})</span></div></div>
    <p>${c.agreement_at_current != null ? `Sensor and people currently agree on smell or no smell in <b>${c.agreement_at_current}%</b> of reports.` : ''} ${enough ? `Suggested: noticeable from <b>${c.suggest_noticeable}</b>, strong from <b>${c.suggest_strong}</b>.` : 'At least 30 reports are needed, with both smell and no-smell answers, before a suggestion is reliable.'}</p>
    <form class="row" id="th"><label>Noticeable from<input id="tn" type="number" min="1" max="99" value="${enough ? c.suggest_noticeable : s.noticeable}"></label><label>Strong from<input id="ts" type="number" min="2" max="100" value="${enough && c.suggest_strong > c.suggest_noticeable ? c.suggest_strong : s.strong}"></label><button class="btn primary">Save thresholds</button><span class="note" id="thm" role="status"></span></form></section>
    <section class="card"><h2 style="margin-bottom:8px">Latest matched reports</h2><div class="tscroll"><table><thead><tr><th>Time</th><th>Location</th><th>Person said</th><th class="num">Sensor index</th></tr></thead><tbody>${c.rows.map(r => `<tr><td>${fmtDate(r.t)} ${fmtTime(r.t)}</td><td>${esc(r.location)}</td><td>${['No smell', 'Noticeable', 'Strong'][r.level]}</td><td class="num">${r.index}</td></tr>`).join('') || '<tr><td colspan="4">No reports yet</td></tr>'}</tbody></table></div></section>`;
  $('#th').onsubmit = async e => { e.preventDefault(); try { await rpc('admin_set_thresholds', { p_noticeable: Number($('#tn').value), p_strong: Number($('#ts').value) }, true); data = await rpc('admin_overview', {}, true); $('#thm').textContent = 'Saved. Nodes pick this up on their next send.'; $('#thm').className = 'note ok'; } catch (x) { $('#thm').textContent = x.message; $('#thm').className = 'note err'; } };
}
// ---------- reliability evidence
function reliability() {
  const now = Date.now();
  $('#view').innerHTML = `<section class="card"><div class="head"><h2>Delivery evidence</h2></div><div class="row"><label>Device<select id="rd">${data.devices.map(d => `<option>${esc(d.id)}</option>`).join('')}</select></label><label>From<input type="datetime-local" id="ra" value="${new Date(now - 864e5 + 288e5).toISOString().slice(0, 16)}"></label><label>To<input type="datetime-local" id="rb" value="${new Date(now + 288e5).toISOString().slice(0, 16)}"></label><span class="note">Malaysia time</span><button class="btn primary" id="rg">Calculate</button></div><div id="ro" style="margin-top:14px"></div></section>`;
  $('#rg').onclick = async () => {
    const r = await rpc('admin_reliability', { p_device: $('#rd').value, p_from: iso($('#ra').value + '+08:00'), p_to: iso($('#rb').value + '+08:00') }, true);
    $('#ro').innerHTML = `<div class="kpis">${[[r.delivery_pct + '%', 'delivery rate'], [`${r.stored} / ${r.expected}`, 'readings stored / expected'], [r.duplicates_in_table, 'duplicates stored'], [r.duplicates_rejected, 'retries safely ignored'], [r.replayed, 'readings sent late after an outage'], [r.max_recovery_minutes ?? '–', 'longest recovery (minutes)'], [r.longest_gap_minutes ?? '–', 'longest gap (minutes)'], [r.median_delay_seconds ?? '–', 'median delay (seconds)']].map(([a, b]) => `<div class="kpi"><b>${esc(a)}</b><span>${b}</span></div>`).join('')}</div>`;
  };
  if (data.devices.length) $('#rg').click();
}
function alerts() {
  $('#view').innerHTML = `<section class="card"><div class="head"><h2>Alert history</h2><span class="sub">Telegram ${data.telegram_configured ? 'connected' : 'not set up: alerts are recorded here only'}</span></div><div class="tscroll"><table><thead><tr><th>Time</th><th>To</th><th>Message</th><th>Status</th></tr></thead><tbody>${data.alerts.map(a => `<tr><td>${fmtDate(a.created_at)} ${fmtTime(a.created_at)}</td><td>${a.audience === 'public' ? 'Students' : 'Admin'}</td><td>${esc(a.message)}</td><td>${esc(a.status)}</td></tr>`).join('') || '<tr><td colspan="4">No alerts yet</td></tr>'}</tbody></table></div></section>`;
}
token() ? boot() : showLogin();
