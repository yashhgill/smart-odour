/* ==========================================================================
   Smart Odour Monitoring — dashboard logic

   Two independent data paths, deliberately:
     1. MQTT over WSS straight from HiveMQ  → the live station tile.
     2. HTTPS through the Cloudflare Worker → everything else.

   If Render is down, path 2 falls back to the standby origin or to the
   Worker's cached snapshot, and path 1 keeps running regardless. The
   dashboard should never go blank in front of an examiner.
   ========================================================================== */

const CFG = window.CONFIG;
const $ = (id) => document.getElementById(id);

const state = {
  zones: [],
  latest: [],          // one row per zone
  selectedZone: 1,
  historyHours: 6,
  forecast: null,
  uptime: null,
  incidents: [],
  openOnly: true,
  origin: null,
  mqttUp: false,
  lastMqttAt: 0,
};

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));

/** Mirrors odourIndex() in worker/src/index.js. Keep the two in step. */
function odourIndex(r) {
  const n = (v, ceiling) => clamp((v || 0) / ceiling, 0, 1);
  const score =
    0.20  * n(r.mq5,   1200) +
    0.45  * n(r.mq6,   1200) +
    0.175 * n(r.mq7_1,  900) +
    0.175 * n(r.mq7_2,  900);
  return Math.round(score * 1000) / 10;
}

function band(index) {
  if (index >= CFG.BANDS.hazardous) return 'hazardous';
  if (index >= CFG.BANDS.warning) return 'warning';
  return 'normal';
}

function timeOfDay(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const svgNS = 'http://www.w3.org/2000/svg';
function el(name, attrs = {}, text) {
  const node = document.createElementNS(svgNS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/* -------------------------------------------------------------------------- */
/*  API                                                                        */
/* -------------------------------------------------------------------------- */

async function api(path, options = {}) {
  const res = await fetch(CFG.API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const servedBy = res.headers.get('X-Served-By');
  if (servedBy) setOrigin(servedBy);
  if (!res.ok) throw new Error(`${res.status} on ${path}`);
  return res.status === 204 ? null : res.json();
}

function setOrigin(name) {
  if (state.origin === name) return;
  state.origin = name;
  const pill = $('pill-origin');
  const label = name === 'standby' ? 'Serving from standby'
              : name === 'cache'   ? 'Serving from edge cache'
              : 'Serving from primary';
  pill.querySelector('.pill__text').textContent = label;
  pill.classList.toggle('is-live', name === 'primary');
  pill.classList.toggle('is-warn', name === 'standby' || name === 'cache');
}

function setFeed(status, text) {
  const pill = $('pill-feed');
  pill.classList.remove('is-live', 'is-warn', 'is-down');
  if (status) pill.classList.add(status);
  pill.querySelector('.pill__text').textContent = text;
}

/* -------------------------------------------------------------------------- */
/*  Live MQTT — station 1 only                                                 */
/* -------------------------------------------------------------------------- */

function connectMqtt() {
  if (!CFG.MQTT.enabled || typeof mqtt === 'undefined') {
    setFeed('is-warn', 'Polling only');
    return;
  }
  let client;
  try {
    client = mqtt.connect(CFG.MQTT.url, {
      username: CFG.MQTT.username,
      password: CFG.MQTT.password,
      reconnectPeriod: 4000,
      connectTimeout: 8000,
      clean: true,
    });
  } catch (err) {
    setFeed('is-warn', 'Polling only');
    return;
  }

  client.on('connect', () => {
    state.mqttUp = true;
    setFeed('is-live', 'Live feed');
    client.subscribe(CFG.MQTT.topic);
  });

  client.on('message', (topic, buf) => {
    if (topic.endsWith('/health')) return;
    let payload;
    try { payload = JSON.parse(buf.toString()); } catch { return; }

    state.lastMqttAt = Date.now();
    const zoneId = payload.zone_id || 1;
    const row = state.latest.find((r) => r.zone_id === zoneId);
    const merged = {
      ...(row || {}),
      zone_id: zoneId,
      zone_name: row?.zone_name || payload.location || 'Station 1',
      is_physical: true,
      ts: new Date().toISOString(),
      temperature: payload.temperature,
      humidity: payload.humidity,
      mq5: payload.mq5, mq6: payload.mq6,
      mq7_1: payload.mq7_1, mq7_2: payload.mq7_2,
      source: 'live',
    };
    merged.aqi_score = odourIndex(merged);
    merged.status = band(merged.aqi_score);

    if (row) Object.assign(row, merged);
    else state.latest.push(merged);

    renderStations();
    renderMap();
  });

  client.on('error', () => setFeed('is-warn', 'Feed degraded'));
  client.on('close', () => {
    if (state.mqttUp) setFeed('is-warn', 'Reconnecting');
    state.mqttUp = false;
  });
}

/* -------------------------------------------------------------------------- */
/*  Stations                                                                   */
/* -------------------------------------------------------------------------- */

function renderStations() {
  const host = $('stations');
  if (!state.latest.length) return;

  const rows = [...state.latest].sort((a, b) => a.zone_id - b.zone_id);
  host.innerHTML = '';

  for (const r of rows) {
    const index = r.aqi_score ?? 0;
    const state_ = r.status || band(index);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `station station--${state_}` + (r.zone_id === state.selectedZone ? ' is-selected' : '');
    card.setAttribute('aria-pressed', String(r.zone_id === state.selectedZone));

    card.innerHTML = `
      <div class="station__top">
        <span>Station ${r.zone_id}</span>
        <span class="tag ${r.is_physical ? 'tag--live' : ''}">${r.is_physical ? 'Hardware' : 'Recorded'}</span>
        <span style="margin-left:auto">${ago(r.ts)}</span>
      </div>
      <div class="station__name">${r.zone_name || 'Unnamed'}</div>
      <div>
        <span class="station__index">${num(index, 1)}</span>
        <span class="station__state">${state_}</span>
      </div>
      <div class="station__gases">
        <span>MQ5 <b>${num(r.mq5, 0)}</b></span>
        <span>MQ6 <b>${num(r.mq6, 0)}</b></span>
        <span>CO&nbsp;A <b>${num(r.mq7_1, 0)}</b></span>
        <span>CO&nbsp;B <b>${num(r.mq7_2, 0)}</b></span>
        <span>${num(r.temperature, 1)}&deg;C</span>
        <span>${num(r.humidity, 0)}% RH</span>
      </div>`;

    card.addEventListener('click', () => {
      state.selectedZone = r.zone_id;
      renderStations();
      loadForecast();
      loadHistory();
    });
    host.appendChild(card);
  }
}

/* -------------------------------------------------------------------------- */
/*  Dispersion chart                                                           */
/*  Custom SVG rather than a tile map: it renders with no network, which        */
/*  matters when campus WiFi is the weak link during a demo.                    */
/* -------------------------------------------------------------------------- */

const MAP = { w: 600, h: 420, pad: 54 };

function project(zones) {
  const lats = zones.map((z) => z.latitude);
  const lons = zones.map((z) => z.longitude);
  let [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
  let [minLon, maxLon] = [Math.min(...lons), Math.max(...lons)];
  const padLat = (maxLat - minLat) * 0.35 || 0.002;
  const padLon = (maxLon - minLon) * 0.35 || 0.002;
  minLat -= padLat; maxLat += padLat; minLon -= padLon; maxLon += padLon;

  return (lat, lon) => ({
    x: MAP.pad + ((lon - minLon) / (maxLon - minLon)) * (MAP.w - MAP.pad * 2),
    // Latitude increases northwards, y increases downwards.
    y: MAP.pad + ((maxLat - lat) / (maxLat - minLat)) * (MAP.h - MAP.pad * 2),
  });
}

function renderMap() {
  const svg = $('map');
  if (!state.zones.length) return;
  svg.innerHTML = '';
  const to = project(state.zones);

  // Ruling
  const g = el('g');
  for (let x = MAP.pad; x <= MAP.w - MAP.pad; x += 45) {
    g.appendChild(el('line', { x1: x, y1: MAP.pad, x2: x, y2: MAP.h - MAP.pad, class: 'map-grid' }));
  }
  for (let y = MAP.pad; y <= MAP.h - MAP.pad; y += 45) {
    g.appendChild(el('line', { x1: MAP.pad, y1: y, x2: MAP.w - MAP.pad, y2: y, class: 'map-grid' }));
  }
  svg.appendChild(g);
  svg.appendChild(el('text', { x: MAP.pad, y: MAP.pad - 16, class: 'zone-sub' }, 'N ↑'));

  // Plume from the strongest station, if we have a wind bearing.
  const plume = state.forecast?.plume;
  const source = state.latest.find((r) => r.zone_id === state.forecast?.zone?.id);
  if (plume?.available && source) {
    const p = to(sourceLat(source), sourceLon(source));
    const index = source.aqi_score ?? 0;
    if (plume.regime === 'stagnant') {
      for (let i = 3; i >= 1; i--) {
        svg.appendChild(el('circle', {
          cx: p.x, cy: p.y, r: 14 * i,
          class: 'contour',
          'stroke-width': 1.2,
          'stroke-opacity': 0.15 + 0.12 * (4 - i),
          'stroke-dasharray': '3 3',
        }));
      }
    } else {
      const bearing = (plume.travel_bearing_deg ?? 0) * Math.PI / 180;
      const half = (plume.cone_half_angle_deg ?? 30) * Math.PI / 180;
      // Bearing is clockwise from north; screen y is inverted.
      const dir = { x: Math.sin(bearing), y: -Math.cos(bearing) };
      const perp = { x: -dir.y, y: dir.x };

      for (let step = 4; step >= 1; step--) {
        const reach = 34 * step * (0.55 + index / 140);
        const spread = Math.tan(half) * reach;
        const tip = { x: p.x + dir.x * reach, y: p.y + dir.y * reach };
        const a = { x: tip.x + perp.x * spread, y: tip.y + perp.y * spread };
        const b = { x: tip.x - perp.x * spread, y: tip.y - perp.y * spread };
        svg.appendChild(el('path', {
          d: `M ${p.x} ${p.y} L ${a.x} ${a.y} Q ${tip.x + dir.x * 12} ${tip.y + dir.y * 12} ${b.x} ${b.y} Z`,
          fill: 'var(--plume)',
          'fill-opacity': (0.16 - step * 0.028).toFixed(3),
          stroke: 'var(--plume)',
          'stroke-opacity': 0.16,
          'stroke-width': 0.8,
        }));
      }
    }
  }

  // Stations
  for (const z of state.zones) {
    const r = state.latest.find((x) => x.zone_id === z.id) || {};
    const index = r.aqi_score ?? 0;
    const state_ = r.status || band(index);
    const p = to(z.latitude, z.longitude);
    const colour = `var(--${state_})`;

    if (state_ !== 'normal') {
      svg.appendChild(el('circle', {
        cx: p.x, cy: p.y, r: 10 + index * 0.22,
        fill: colour, 'fill-opacity': 0.13,
      }));
    }
    svg.appendChild(el('circle', {
      cx: p.x, cy: p.y, r: z.is_physical ? 7 : 5.5,
      fill: z.is_physical ? colour : 'var(--panel)',
      stroke: colour, 'stroke-width': z.is_physical ? 1.5 : 2,
      'stroke-dasharray': z.is_physical ? '' : '2.5 2',
    }));

    const flip = p.x > MAP.w - 150;
    const tx = flip ? p.x - 13 : p.x + 13;
    const anchor = flip ? 'end' : 'start';
    svg.appendChild(el('text', { x: tx, y: p.y - 2, class: 'zone-label', 'text-anchor': anchor },
      (z.code || `Z${z.id}`) + ' · ' + num(index, 0)));
    svg.appendChild(el('text', { x: tx, y: p.y + 11, class: 'zone-sub', 'text-anchor': anchor },
      z.name.length > 26 ? z.name.slice(0, 25) + '…' : z.name));
  }
}

const sourceLat = (row) => state.zones.find((z) => z.id === row.zone_id)?.latitude ?? 0;
const sourceLon = (row) => state.zones.find((z) => z.id === row.zone_id)?.longitude ?? 0;

/* -------------------------------------------------------------------------- */
/*  Forecast                                                                   */
/* -------------------------------------------------------------------------- */

function renderForecast() {
  const host = $('forecast');
  const f = state.forecast;
  if (!f) return;

  $('forecast-zone').textContent = f.zone?.name || '—';

  const w = f.weather || {};
  const needle = $('rose-needle');
  if (w.wind_from_deg !== null && w.wind_from_deg !== undefined) {
    needle.setAttribute('transform', `rotate(${w.wind_from_deg} 45 45)`);
    $('wind-read').textContent = `${w.wind_from_compass ?? '—'} ${num(w.wind_speed_ms, 1)} m/s`;
  } else {
    $('wind-read').textContent = 'no wind data';
  }

  const p = f.plume || {};
  let html = '';

  if (!p.available) {
    html += `<p class="forecast__lede">No directional forecast: ${p.reason || 'weather unavailable'}.</p>`;
  } else if (p.regime === 'stagnant') {
    html += `<p class="forecast__lede">${p.note}</p>`;
  } else if (!p.affected?.length) {
    html += `<p class="forecast__lede">Odour is drifting <b>${p.travel_compass}</b> at
      <b>${num(p.wind_speed_ms, 1)} m/s</b>, away from every monitored building.
      Nothing downwind within range.</p>`;
  } else {
    html += `<p class="forecast__lede">Odour is drifting <b>${p.travel_compass}</b> at
      <b>${num(p.wind_speed_ms, 1)} m/s</b>. Expected to reach:</p>`;
    for (const a of p.affected) {
      html += `
        <div class="receptor">
          <span class="receptor__name">${a.name}<br>
            <span class="zone-sub" style="font-family:var(--mono)">${a.distance_m} m · bearing ${a.bearing_deg}°</span>
          </span>
          <span class="receptor__eta">${a.eta_clock}<br>
            <span class="risk--low">in ${a.eta_minutes} min</span>
          </span>
          <span class="receptor__idx risk--${a.risk}">${num(a.projected_index, 0)}</span>
        </div>`;
    }
  }

  host.innerHTML = html + trendMarkup(f.trend);
  if (f.trend?.available) drawTrend(f.trend);
}

function trendMarkup(t) {
  if (!t?.available) return '';
  const dir = t.direction || 'stable';
  const peak = t.peak_value !== undefined ? t.peak_value : (t.peak?.value);
  return `
    <div class="trendline">
      <span class="figure__label">Next three hours &mdash; ${dir}${peak !== undefined ? `, peaking near ${num(peak, 0)}` : ''}</span>
      <svg id="trendsvg" viewBox="0 0 320 90" role="img" aria-label="Projected odour index for the next three hours with uncertainty band"></svg>
    </div>`;
}

function drawTrend(t) {
  const svg = $('trendsvg');
  if (!svg || !t.points?.length) return;
  const W = 320, H = 90, pad = 6;
  const xs = (i) => pad + (i / (t.points.length - 1)) * (W - pad * 2);
  const ys = (v) => H - pad - (clamp(v, 0, 100) / 100) * (H - pad * 2);

  const upper = t.points.map((p, i) => `${xs(i)},${ys(p.upper)}`).join(' ');
  const lower = t.points.map((p, i) => `${xs(i)},${ys(p.lower)}`).reverse().join(' ');
  svg.appendChild(el('polygon', { points: `${upper} ${lower}`, class: 'trend__band' }));
  svg.appendChild(el('polyline', {
    points: t.points.map((p, i) => `${xs(i)},${ys(p.value)}`).join(' '),
    class: 'trend__line',
  }));

  for (const level of [CFG.BANDS.warning, CFG.BANDS.hazardous]) {
    svg.appendChild(el('line', {
      x1: pad, y1: ys(level), x2: W - pad, y2: ys(level), class: 'hist__band',
    }));
  }
}

/* -------------------------------------------------------------------------- */
/*  Availability trace                                                         */
/* -------------------------------------------------------------------------- */

function renderUptime() {
  const u = state.uptime;
  if (!u) return;

  const primary = (u.summary || []).find((s) => s.origin === 'primary') || (u.summary || [])[0];
  $('fig-uptime').textContent = primary?.uptime_pct !== undefined ? `${num(primary.uptime_pct, 2)}%` : '—';
  $('fig-latency').textContent = primary?.avg_latency_ms !== undefined && primary.avg_latency_ms !== null
    ? `${Math.round(primary.avg_latency_ms)} ms` : '—';
  $('fig-failovers').textContent = (u.recent_failovers || []).length;

  const svg = $('strip');
  svg.innerHTML = '';
  const samples = (u.samples || []).filter((s) => s.origin === 'primary' || !primary);
  const W = 720, H = 120, pad = 22;
  if (!samples.length) {
    svg.appendChild(el('text', { x: pad, y: H / 2, class: 'axis' }, 'No probe samples yet — the cron writes one per minute.'));
    return;
  }

  const lat = samples.map((s) => s.latency_ms || 0);
  const max = Math.max(200, ...lat) * 1.15;
  const xs = (i) => pad + (i / Math.max(1, samples.length - 1)) * (W - pad * 2);
  const ys = (v) => H - pad - (clamp(v, 0, max) / max) * (H - pad * 2);

  // Downtime shading first, so the trace sits on top.
  let runStart = null;
  samples.forEach((s, i) => {
    if (!s.healthy && runStart === null) runStart = i;
    if ((s.healthy || i === samples.length - 1) && runStart !== null) {
      svg.appendChild(el('rect', {
        x: xs(runStart), y: pad, width: Math.max(2, xs(i) - xs(runStart)),
        height: H - pad * 2, class: 'strip__gap',
      }));
      runStart = null;
    }
  });

  svg.appendChild(el('line', { x1: pad, y1: H - pad, x2: W - pad, y2: H - pad, class: 'map-grid' }));
  svg.appendChild(el('polyline', {
    points: samples.map((s, i) => `${xs(i)},${ys(s.latency_ms || 0)}`).join(' '),
    class: 'strip__trace',
  }));

  svg.appendChild(el('text', { x: pad, y: pad - 6, class: 'axis' }, `${Math.round(max)} ms`));
  svg.appendChild(el('text', { x: pad, y: H - 6, class: 'axis' }, timeOfDay(samples[0].ts)));
  svg.appendChild(el('text', { x: W - pad, y: H - 6, class: 'axis', 'text-anchor': 'end' },
    timeOfDay(samples[samples.length - 1].ts)));
}

/* -------------------------------------------------------------------------- */
/*  Station history                                                            */
/* -------------------------------------------------------------------------- */

async function loadHistory() {
  const svg = $('history');
  try {
    const rows = await api(`/readings?zone_id=${state.selectedZone}&hours=${state.historyHours}&limit=1200`);
    svg.innerHTML = '';
    const pts = rows.filter((r) => r.aqi_score !== null && r.aqi_score !== undefined);
    if (!pts.length) {
      svg.appendChild(el('text', { x: 24, y: 100, class: 'axis' }, 'No readings in this window.'));
      return;
    }
    const W = 720, H = 200, pad = 26;
    const xs = (i) => pad + (i / Math.max(1, pts.length - 1)) * (W - pad * 2);
    const ys = (v) => H - pad - (clamp(v, 0, 100) / 100) * (H - pad * 2);

    for (const level of [CFG.BANDS.warning, CFG.BANDS.hazardous]) {
      svg.appendChild(el('line', { x1: pad, y1: ys(level), x2: W - pad, y2: ys(level), class: 'hist__band' }));
      svg.appendChild(el('text', { x: W - pad + 2, y: ys(level) + 3, class: 'axis' }, String(level)));
    }
    svg.appendChild(el('polyline', {
      points: pts.map((p, i) => `${xs(i)},${ys(p.aqi_score)}`).join(' '),
      class: 'hist__line',
    }));
    svg.appendChild(el('text', { x: pad, y: H - 6, class: 'axis' }, timeOfDay(pts[0].ts)));
    svg.appendChild(el('text', { x: W - pad, y: H - 6, class: 'axis', 'text-anchor': 'end' },
      timeOfDay(pts[pts.length - 1].ts)));
  } catch (err) {
    svg.innerHTML = '';
    svg.appendChild(el('text', { x: 24, y: 100, class: 'axis' }, 'History unavailable — the origin did not answer.'));
  }
}

/* -------------------------------------------------------------------------- */
/*  Incidents                                                                  */
/* -------------------------------------------------------------------------- */

function renderIncidents() {
  const host = $('incidents');
  const rows = state.incidents;
  if (!rows.length) {
    host.innerHTML = '<p class="empty">No incidents recorded. The network is within thresholds.</p>';
    return;
  }
  host.innerHTML = '';
  for (const i of rows) {
    const card = document.createElement('article');
    card.className = `incident incident--${i.severity || 'warning'}`;
    const acked = Boolean(i.acknowledged_at);
    const resolved = Boolean(i.resolved_at);
    const stateLabel = resolved ? 'Resolved' : acked ? 'Acknowledged' : 'Open';

    card.innerHTML = `
      <div class="incident__head">
        <span>${i.kind === 'failover' ? 'Infrastructure' : i.kind === 'node_offline' ? 'Station offline' : 'Threshold'} · ${stateLabel}</span>
        <span class="incident__when">${timeOfDay(i.opened_at)} · ${ago(i.opened_at)}</span>
      </div>
      <p class="incident__msg">${i.message || ''}</p>
      <div class="incident__acts"></div>`;

    const acts = card.querySelector('.incident__acts');
    if (!acked && !resolved) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.textContent = 'Acknowledge';
      b.addEventListener('click', () => act(i.id, 'acknowledge', b));
      acts.appendChild(b);
    }
    if (!resolved) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn--ghost'; b.textContent = 'Resolve';
      b.addEventListener('click', () => act(i.id, 'resolve', b));
      acts.appendChild(b);
    }
    host.appendChild(card);
  }
}

async function act(id, verb, button) {
  button.disabled = true;
  button.textContent = verb === 'acknowledge' ? 'Acknowledging…' : 'Resolving…';
  try {
    await api(`/incidents/${id}/${verb}`, { method: 'PATCH' });
    await loadIncidents();
  } catch {
    button.disabled = false;
    button.textContent = verb === 'acknowledge' ? 'Acknowledge' : 'Resolve';
  }
}

/* -------------------------------------------------------------------------- */
/*  ESG report                                                                 */
/* -------------------------------------------------------------------------- */

async function generateReport() {
  const btn = $('report-go');
  const status = $('report-status');
  const days = $('report-days').value;

  btn.disabled = true;
  btn.textContent = 'Generating…';
  status.textContent = `Compiling ${days} days of readings across all four stations.`;

  try {
    // This endpoint streams the PDF back rather than returning JSON, so it
    // bypasses api() and handles the blob directly.
    const res = await fetch(`${CFG.API_BASE}/reports/esg?days=${days}`, {
      method: 'POST',
      headers: { 'X-Admin-Token': CFG.ADMIN_TOKEN || '' },
    });
    if (res.status === 401 || res.status === 403) {
      status.textContent = 'Not authorised. Set ADMIN_TOKEN in config.js to match the backend.';
      return;
    }
    if (!res.ok) throw new Error(String(res.status));

    const blob = await res.blob();
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1]
                 || `ESG_Odour_Report_${days}d.pdf`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    status.textContent = `Downloaded ${name}. A copy is archived in R2.`;
    await loadReports();
  } catch (err) {
    status.textContent = 'Could not generate the report. The origin returned an error — check the Render logs.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate report';
  }
}

async function loadReports() {
  try {
    const rows = await api('/reports?limit=6');
    const list = $('report-list');
    list.innerHTML = '';
    for (const r of rows) {
      const li = document.createElement('li');
      const when = new Date(r.generated_at).toLocaleString('en-GB',
        { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      li.textContent = `${when} · ${r.title || 'ESG report'} · ${r.r2_key || 'not archived'}`;
      list.appendChild(li);
    }
  } catch { /* the list is optional */ }
}

/* -------------------------------------------------------------------------- */
/*  Loaders                                                                    */
/* -------------------------------------------------------------------------- */

async function loadCore() {
  try {
    const [zones, latest] = await Promise.all([api('/zones'), api('/latest')]);
    state.zones = zones;
    // Keep any fresher MQTT row rather than overwriting it with a polled one.
    const fresh = Date.now() - state.lastMqttAt < 20000;
    state.latest = latest.map((r) => {
      const live = fresh && state.latest.find((x) => x.zone_id === r.zone_id && x.source === 'live');
      return live || r;
    });
    renderStations();
    renderMap();
    if (!state.mqttUp) setFeed('is-warn', 'Polling');
  } catch {
    setFeed('is-down', 'Origin unreachable');
  }
}

async function loadForecast() {
  try {
    state.forecast = await api(`/predict?zone_id=${state.selectedZone}`);
    renderForecast();
    renderMap();
  } catch { /* keep the previous forecast on screen */ }
}

async function loadUptime() {
  try {
    state.uptime = await api('/uptime');
    renderUptime();
  } catch { /* leave the last trace visible */ }
}

async function loadIncidents() {
  try {
    state.incidents = await api(`/incidents?open_only=${state.openOnly}&limit=40`);
    renderIncidents();
  } catch { /* leave the last list visible */ }
}

/* -------------------------------------------------------------------------- */
/*  Boot                                                                       */
/* -------------------------------------------------------------------------- */

function tickClock() {
  $('clock').textContent =
    new Date().toLocaleTimeString('en-GB', { hour12: false }) + ' ' + CFG.TZ_LABEL;
}

function wireControls() {
  document.querySelectorAll('#history-range button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#history-range button').forEach((x) => x.classList.remove('is-active'));
      b.classList.add('is-active');
      state.historyHours = Number(b.dataset.hours);
      loadHistory();
    });
  });
  $('incidents-open').addEventListener('change', (e) => {
    state.openOnly = e.target.checked;
    loadIncidents();
  });
  $('report-go').addEventListener('click', generateReport);
}

async function boot() {
  tickClock();
  setInterval(tickClock, 1000);
  wireControls();
  connectMqtt();

  await loadCore();
  await Promise.all([loadForecast(), loadUptime(), loadIncidents(), loadHistory(), loadReports()]);

  setInterval(loadCore, CFG.POLL_MS);
  setInterval(loadIncidents, CFG.POLL_MS);
  setInterval(loadUptime, 60000);
  setInterval(loadForecast, 180000);
  setInterval(() => {
    // Stale live feed with no MQTT traffic means the node or the broker dropped.
    if (state.mqttUp && Date.now() - state.lastMqttAt > 45000) setFeed('is-warn', 'Station 1 silent');
  }, 10000);
}

document.addEventListener('DOMContentLoaded', boot);
