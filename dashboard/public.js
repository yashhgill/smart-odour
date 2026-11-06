let selected = null, locs = [], settings = {}, map = null;
const pins = {}, side = {};
$('#mk').innerHTML = LOGO; themeButton($('#theme'));
if (C.DEMO || C.BANNER) $('#demo').innerHTML = `<div class="demo">${esc(C.BANNER || 'Demonstration with simulated data')}</div>`;
if (C.TELEGRAM_LINK) { const t = $('#tg'); t.href = C.TELEGRAM_LINK; t.hidden = false; }

// During learning the number is shown but carries no level, because it isn't meaningful yet.
const shownIndex = l => l.online && l.recorded_at ? l.odour_index : null;
const levelOf = l => l.online && !l.learning ? l.level : null;
const wordOf = l => !l.has_device && !l.recorded_at ? 'No sensor' : !l.online ? 'Offline' : l.learning ? 'Learning' : LEVELS[l.level];

// A ring of dots: how much of the 0 to 100 scale is lit.
function dotRing(index, lvl) {
  const N = 24, c = 50, r = 42, lit = index == null ? 0 : Math.round(index / 100 * N);
  let s = `<svg class="ring" viewBox="0 0 100 100" aria-hidden="true">`;
  for (let k = 0; k < N; k++) {
    const a = k / N * 2 * Math.PI - Math.PI / 2;
    s += `<circle cx="${(c + r * Math.cos(a)).toFixed(2)}" cy="${(c + r * Math.sin(a)).toFixed(2)}" r="3.1" fill="${k < lit ? `var(--l${lvl})` : 'var(--dot-off)'}"/>`;
  }
  return s + `<text x="50" y="58" text-anchor="middle" font-size="25" font-weight="600" fill="currentColor">${index == null ? '–' : Math.round(index)}</text></svg>`;
}
// The last 24 hours as a coloured strip.
function ribbon(points, s) {
  const W = 480, now = Date.now(), span = 864e5, step = 360e3;
  const color = i => i >= s.strong ? 'var(--l2)' : i >= s.noticeable ? 'var(--l1)' : 'var(--l0-soft)';
  let out = `<svg class="ribbon" viewBox="0 0 ${W} 22" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Odour level over the last 24 hours"><rect width="${W}" height="22" fill="var(--dot-off)"/>`;
  points.forEach(p => {
    const x = (new Date(p.t) - (now - span)) / span * W;
    if (x < -2) return;
    out += `<rect x="${x.toFixed(1)}" width="${(step / span * W + 1.2).toFixed(2)}" height="22" fill="${color(Number(p.max))}"/>`;
  });
  return out + '</svg>';
}
function scale(s) {
  const a = s.noticeable, b = s.strong;
  $('#scale').innerHTML = `<div class="scale"><div class="seg s0" style="flex:${a}"><b>Normal</b><span>Below ${a}. No action needed.</span></div><div class="seg s1" style="flex:${b - a}"><b>Noticeable</b><span>${a} to ${b - 1}. You may smell it.</span></div><div class="seg s2" style="flex:${Math.max(100 - b, 28)}"><b>Strong</b><span>${b} and above. Close windows if you can.</span></div></div>`;
}
function pinIcon(l) {
  const lvl = levelOf(l), raw = shownIndex(l), v = raw == null ? null : Math.round(raw), size = lvl == null ? 0 : 44 + v * 1.5;
  return L.divIcon({ className: '', iconSize: [0, 0], html:
    `<div class="pin p${lvl ?? 'x'} ${side[l.id] || ''} ${selected === l.id ? 'on' : ''}"><i class="halo" style="width:${size}px;height:${size}px"></i><b>${v ?? '–'}</b><span>${esc(l.name)}</span></div>` });
}
const FARM = [2.3190, 102.3118]; // The poultry sheds nearest campus, from OpenStreetMap. A landmark, not a sensor.
function drawMap() {
  if (!window.L || !$('#map')) return;
  const placed = locs.filter(l => l.lat != null && l.lng != null);
  if (!map) {
    map = L.map('map', { scrollWheelZoom: false, attributionControl: true, zoomSnap: .25 });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery &copy; Esri and contributors' }).addTo(map);
    map.setView([2.3125, 102.32], 15);
    L.marker(FARM, { interactive: false, keyboard: false, zIndexOffset: -500, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="farmtag">Chicken farm</div>' }) }).addTo(map);
    // Keep every pin in view as the card changes size, until the visitor moves the map themselves.
    let touched = false;
    const fit = () => { map.invalidateSize(); if (!touched && placed.length) map.fitBounds([FARM, ...placed.map(l => [l.lat, l.lng])], { padding: [55, 55], animate: false }); };
    ['mousedown', 'touchstart'].forEach(ev => $('#map').addEventListener(ev, () => { touched = true; }, { passive: true }));
    new ResizeObserver(fit).observe($('#map'));
    fit();
  }
  // Labels alternate sides from north to south, so neighbouring pins do not cover each other's names.
  [...placed].sort((a, b) => b.lat - a.lat || a.id - b.id).forEach((l, i) => { side[l.id] = i % 2 ? 'sl' : 'sr'; });
  placed.forEach(l => {
    if (pins[l.id]) pins[l.id].setIcon(pinIcon(l)).setLatLng([l.lat, l.lng]);
    else pins[l.id] = L.marker([l.lat, l.lng], { icon: pinIcon(l), title: l.name, alt: l.name, riseOnHover: true }).addTo(map).on('click', () => choose(l.id));
    pins[l.id].setZIndexOffset((levelOf(l) ?? -1) * 100);
  });
}
function choose(id) { selected = selected === id ? null : id; paint(); loadHistory(); }
let trends = [];
function paint() {
  drawMap();
  const from = new Date(Date.now() - 864e5);
  $('#locs').innerHTML = locs.map((l, k) => {
    const lvl = levelOf(l);
    const meta = !l.recorded_at ? 'Sensor not placed here yet' : `${l.temperature != null ? `${Math.round(l.temperature)}°C, ${Math.round(l.humidity)}% humidity. ` : ''}Read ${fmtDate(l.recorded_at)} ${fmtTime(l.recorded_at)}`;
    return `<button class="card loc l${lvl ?? 'x'} ${selected === l.id ? 'on' : ''}" data-id="${l.id}" aria-pressed="${selected === l.id}">
      <span class="ltop"><span class="name">${esc(l.name)}</span><span class="chip">${wordOf(l)}</span></span>
      ${dotRing(shownIndex(l), lvl ?? 'x')}
      <span class="rb">${ribbon(trends[k] || [], settings)}<span class="axis"><span>${fmtTime(from)}</span><span>Now</span></span></span>
      <span class="meta">${meta}</span></button>`;
  }).join('') || '<div class="empty">No locations set up yet.</div>';
  document.querySelectorAll('.loc').forEach(b => b.onclick = () => choose(Number(b.dataset.id)));
}
async function loadStatus() {
  const st = await rpc('get_status');
  settings = st.settings; locs = st.locations;
  const live = locs.filter(l => levelOf(l) != null);
  const worst = Math.max(0, ...live.map(l => l.level));
  const bad = live.filter(l => l.level === worst && worst > 0).map(l => l.name);
  const learning = locs.filter(l => l.online && l.learning);
  $('#headline').textContent = !locs.some(l => l.online) ? 'NO SENSORS ONLINE' : !live.length && learning.length ? 'LEARNING CLEAN AIR' : worst === 2 ? 'CLOSE YOUR WINDOWS' : worst === 1 ? 'YOU MAY SMELL IT' : 'AIR IS NORMAL';
  $('#where').textContent = !live.length && learning.length ? `${learning.map(l => l.name).join(', ')}: levels start after 24 hours of learning.` : !live.length ? 'No location is reporting right now.' : worst === 0 ? `Normal at all ${live.length} reporting locations.` : `${LEVELS[worst]} odour at ${bad.join(', ')}.`;
  $('#updated').textContent = 'UPDATED ' + fmtTime(st.server_time);
  const chip = $('#dchip'); chip.textContent = live.length ? LEVELS[worst].toUpperCase() : 'NO DATA'; chip.className = 'dchip c' + (live.length ? worst : 'x');
  scale(settings);
  trends = await Promise.all(locs.map(l => l.has_device || l.recorded_at ? rpc('get_trend', { p_location: l.id, p_hours: 24 }) : []));
  paint();
  const rl = $('#rloc'), keep = rl.value;
  rl.innerHTML = locs.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  if (keep) rl.value = keep;
  $('#foot').textContent = 'The Odour Index compares each gas sensor with its own clean-air reading. It shows relative change and is not a certified gas measurement. The glow on the map shows the reading at that sensor, not how far the smell has spread. Map positions are approximate. '
    + (settings.calibrated ? 'Levels are calibrated against smell reports from people on campus.' : 'Level thresholds are provisional until enough smell reports have been collected.');
}
// A 24-hour clock with midnight at the top. Each wedge is one hour; longer means more odour.
function clockChart(el, rows) {
  const mins = r => Number(r.noticeable_min) + Number(r.strong_min), total = rows.reduce((n, r) => n + mins(r), 0);
  if (!total) { el.innerHTML = '<div class="empty">No odour recorded in this period.</div>'; return null; }
  const c = 170, r0 = 66, r1 = 142, max = Math.max(...rows.map(mins)), top = rows.reduce((a, b) => mins(b) > mins(a) ? b : a);
  const pt = (r, h) => { const a = h / 24 * 2 * Math.PI - Math.PI / 2; return `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`; };
  const wedge = (a, b, h1, h2) => `M${pt(a, h1)}A${a} ${a} 0 ${h2 - h1 > 12 ? 1 : 0} 1 ${pt(a, h2)}L${pt(b, h2)}A${b} ${b} 0 ${h2 - h1 > 12 ? 1 : 0} 0 ${pt(b, h1)}Z`;
  let s = `<svg class="clock" viewBox="0 0 340 340" role="img" aria-label="Minutes of odour for each hour of the day. Busiest hour ${hourLabel(top.hour)}."><path d="${wedge(r0, r1, 19, 31)}" fill="var(--night)"/>`;
  rows.forEach(r => {
    const h = Number(r.hour), span = r1 - r0, n = Number(r.noticeable_min) / max * span, st = Number(r.strong_min) / max * span;
    s += `<g><title>${hourLabel(h)}: ${r.noticeable_min} min noticeable, ${r.strong_min} min strong</title>`;
    if (n > 0) s += `<path d="${wedge(r0, r0 + n, h + .08, h + .92)}" fill="var(--l1)"/>`;
    if (st > 0) s += `<path d="${wedge(r0 + n, r0 + n + st, h + .08, h + .92)}" fill="var(--l2)"/>`;
    s += '</g>';
  });
  [0, 6, 12, 18].forEach(h => { const a = h / 24 * 2 * Math.PI - Math.PI / 2; s += `<text x="${c + 156 * Math.cos(a)}" y="${c + 156 * Math.sin(a) + 4}" text-anchor="middle" font-size="12" fill="var(--soft)">${String(h).padStart(2, '0')}</text>`; });
  s += `<text x="${c}" y="${c + 2}" text-anchor="middle" font-size="27" font-weight="600" fill="currentColor">${hourLabel(top.hour)}</text><text x="${c}" y="${c + 21}" text-anchor="middle" font-size="12" fill="var(--soft)">busiest hour</text></svg>`;
  el.innerHTML = s;
  return top;
}
async function loadHistory() {
  const days = Number($('#range').value), from = new Date(Date.now() - days * 864e5).toISOString(), to = new Date(Date.now() + 6e4).toISOString();
  const loc = locs.find(l => l.id === selected);
  $('#whenscope').textContent = loc ? `History: ${loc.name}` : 'History: all locations';
  const [hours, sum, all, ev] = await Promise.all([
    rpc('get_hourly', { p_location: selected, p_days: days }),
    rpc('get_summary', { p_from: from, p_to: to, p_location: selected }),
    rpc('get_summary', { p_from: from, p_to: to, p_location: null }),
    rpc('get_events', { p_from: from, p_to: to, p_location: selected, p_limit: 8 }),
  ]);
  const top = clockChart($('#clock'), hours);
  $('#peak').textContent = top ? `Most odour around ${hourLabel(top.hour)}. The shaded part is night, 19:00 to 07:00.` : '';
  const most = Math.max(1, ...all.by_location.map(x => Number(x.events)));
  $('#rank').innerHTML = all.by_location.length ? all.by_location.map(x => {
    const n = Number(x.events), st = Number(x.strong), on = loc && loc.name === x.location;
    return `<div class="rk ${on ? 'on' : ''}"><div class="rkt"><span>${esc(x.location)}</span><b>${n}</b></div><div class="bar"><i style="width:${(n - st) / most * 100}%;background:var(--l1)"></i><i style="width:${st / most * 100}%;background:var(--l2)"></i></div></div>`;
  }).join('') + '<div class="legend" style="margin-top:12px"><span><i style="background:var(--l1)"></i>Noticeable</span><span><i style="background:var(--l2)"></i>Reached strong</span></div>' : '<div class="empty">No odour events in this period.</div>';
  $('#kpis').innerHTML = [[sum.events, 'odour events'], [sum.strong_events, 'reached strong'], [sum.days_with_odour, `of ${days} days affected`], [sum.avg_minutes + ' min', 'typical length']]
    .map(([v, l]) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
  $('#events').innerHTML = ev.length ? `<table class="ev"><thead><tr><th>Location</th><th>Date</th><th>From</th><th>To</th><th class="num">Minutes</th><th>Level</th></tr></thead><tbody>` +
    ev.map(e => `<tr><td>${esc(e.location)}</td><td>${fmtDate(e.started_at)}</td><td>${fmtTime(e.started_at)}</td><td>${e.ended_at ? fmtTime(e.ended_at) : 'Ongoing'}</td><td class="num">${e.minutes}</td><td>${e.strong ? 'Strong' : 'Noticeable'}</td></tr>`).join('') + '</tbody></table>'
    : '<div class="empty">No odour events in this period.</div>';
}
document.querySelectorAll('.say .btn').forEach(b => b.onclick = async () => {
  const m = $('#saymsg');
  try {
    if (C.DEMO_DATA) { m.textContent = 'This is a demonstration, so your answer was not saved.'; m.className = 'note'; return; }
    await rpc('submit_report', { p_location: Number($('#rloc').value), p_level: Number(b.dataset.l) });
    m.textContent = 'Thank you. Your report was recorded.'; m.className = 'note ok';
  } catch (e) { m.textContent = e.message; m.className = 'note err'; }
});
$('#range').onchange = loadHistory;
async function start() {
  try { await loadStatus(); await loadHistory(); }
  catch (e) { $('#headline').textContent = 'SERVICE UNAVAILABLE'; $('#where').textContent = 'Cannot reach the monitoring service right now. Please try again in a moment.'; }
}
start();
setInterval(() => { if (!document.hidden) loadStatus().catch(() => {}); }, 60000);
