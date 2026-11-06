// Local stand-in for Supabase: real SQL running in in-memory Postgres, a REST layer
// shaped like PostgREST, and clearly labelled SIMULATED data. Nothing here is deployed.
//   node dev_server.mjs [port]                 simulated data
//   node dev_server.mjs [port] --live ["place"]  no simulated data: shows real readings sent by
//                                                tools/usb_node.py --dashboard. Kept in memory only; the CSV is the record.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDb, rpc } from './pg.mjs';

const PORT = Number(process.argv[2] || 8787);
const liveAt = process.argv.indexOf('--live'), LIVE = liveAt > 0, LIVE_PLACE = process.argv[liveAt + 1] || 'Kolej Kediaman Lekiu (Satria)';
let liveKey = null;
const ROOT = fileURLToPath(new URL('../dashboard/', import.meta.url));
const ADMIN = '11111111-1111-1111-1111-111111111111';
const asAdmin = { role: 'authenticated', uid: ADMIN };
const db = await makeDb();
await db.query('insert into app_admins values ($1)', [ADMIN]);

// A seeded random so screenshots are repeatable.
let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const DAYS = 14, STEP = 60000, now = Math.floor(Date.now() / STEP) * STEP;
const sites = [['North Perimeter (Farm Side)', 'farm', 1.6, 2.3168, 102.3210], ['Kolej Kediaman Lekiu (Satria)', 'residence', 1.05, 2.3129, 102.3197], ['Kolej Kediaman Lestari', 'residence', 1.0, 2.3098, 102.3232], ['FTMK Faculty Building', 'other', 0.5, 2.3080, 102.3192], ['Main Cafeteria / Waste Bay', 'other', 0.6, 2.3141, 102.3172]];
if (LIVE) {
  for (const [name, kind, , lat, lng] of sites) {
    const id = await rpc(db, 'admin_save_location', { p_id: null, p_name: name, p_kind: kind, p_active: true, p_lat: lat, p_lng: lng }, asAdmin);
    if (name === LIVE_PLACE) liveKey = (await rpc(db, 'admin_save_device', { p_id: 'NODE-1', p_location: id }, asAdmin)).key;
  }
  if (!liveKey) throw new Error('Unknown place: ' + LIVE_PLACE);
} else for (const [i, [name, kind, gain, lat, lng]] of sites.entries()) {
  const id = await rpc(db, 'admin_save_location', { p_id: null, p_name: name, p_kind: kind, p_active: true, p_lat: lat, p_lng: lng }, asAdmin);
  const dev = `SIM-${i + 1}`;
  const { key } = await rpc(db, 'admin_save_device', { p_id: dev, p_location: id }, asAdmin);
  // Plan nightly plumes.
  const plumes = [];
  for (let d = 0; d < DAYS; d++) {
    if (rnd() < 0.72 * Math.min(1, gain)) {
      const local = new Date(now - d * 864e5); local.setUTCHours(13 + Math.floor(rnd() * 8), Math.floor(rnd() * 60), 0, 0); // 21:00 to 04:59 MYT
      plumes.push({ at: local.getTime(), len: (25 + rnd() * 90) * STEP, peak: (28 + rnd() * 34) * gain });
    }
  }
  if (name === 'Kolej Kediaman Lestari') plumes.push({ at: now - 22 * STEP, len: 60 * STEP, peak: 46 });
  if (kind === 'farm') plumes.push({ at: now - 35 * STEP, len: 90 * STEP, peak: 76 });
  let rows = [];
  for (let t = now - DAYS * 864e5; t <= now; t += STEP) {
    let v = 4 + rnd() * 5;
    for (const p of plumes) if (t >= p.at && t <= p.at + p.len) { const f = Math.sin(Math.PI * (t - p.at) / p.len); v = Math.max(v, Math.min(p.peak * Math.pow(f, .5), 100) + rnd() * 4); }
    rows.push({ t: new Date(t).toISOString(), i: +Math.min(v, 100).toFixed(1), r: [1 + v / 100, 1 + v / 120, 1 + v / 90, 1 + v / 150].map(x => +x.toFixed(2)), tc: +(27 + 3 * Math.sin(t / 137e5) + rnd()).toFixed(1), h: Math.round(75 + 10 * Math.sin(t / 137e5)) });
    if (rows.length === 60) { await rpc(db, 'ingest', { p_device: dev, p_key: key, p_rows: rows, p_meta: { fw: 'sim', rssi: -62, q: 0 } }); rows = []; }
  }
  if (rows.length) await rpc(db, 'ingest', { p_device: dev, p_key: key, p_rows: rows, p_meta: { fw: 'sim', rssi: -62, q: 0 } });
  // Simulated smell reports for the calibration screen.
  for (let k = 0; k < 18; k++) {
    const t = new Date(now - rnd() * DAYS * 864e5).toISOString();
    const r = (await db.query('select odour_index i from readings where location_id=$1 order by abs(extract(epoch from recorded_at - $2::timestamptz)) limit 1', [id, t])).rows[0];
    const level = r.i >= 55 ? 2 : r.i >= 25 ? (rnd() < .85 ? 1 : 0) : (rnd() < .92 ? 0 : 1);
    await db.query('insert into smell_reports (location_id, level, created_at) values ($1,$2,$3)', [id, level, t]);
  }
}
await db.exec(`update alerts set status='skipped' where status='pending'`);
console.log(`ready on http://localhost:${PORT} (${LIVE ? 'live USB readings at ' + LIVE_PLACE : 'simulated data'})`);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const STATUS = { PT400: 400, PT401: 401, PT403: 403, PT429: 429, 42501: 401 };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  const read = async () => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
  try {
    if (url.pathname === '/config.js') return send(200, `window.CONFIG={SUPABASE_URL:'',SUPABASE_KEY:'local',TELEGRAM_LINK:${LIVE ? "''" : "'https://t.me/example'"},DEMO:${!LIVE},BANNER:${LIVE ? "'Local test: real readings from the USB sensor node'" : "''"}};` + ((req.headers.referer || '').includes('autologin') ? `sessionStorage.setItem('odour_token','admin-token');` : ''), 'text/javascript');
    if (LIVE && url.pathname === '/local/reading' && req.method === 'POST') {
      return send(200, await rpc(db, 'ingest', { p_device: 'NODE-1', p_key: liveKey, p_rows: [await read()], p_meta: { fw: 'usb', q: 0 } }));
    }
    if (url.pathname === '/auth/v1/token') {
      const b = await read();
      return b.email === 'admin@example.com' && b.password === 'demo' ? send(200, { access_token: 'admin-token' }) : send(400, { message: 'invalid' });
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.split('/').pop();
      if (!/^[a-z_]+$/.test(fn)) return send(404, {});
      const opts = req.headers.authorization === 'Bearer admin-token' ? asAdmin : { role: 'anon' };
      await db.exec(`update devices set last_seen = now() where id like 'SIM-%'`);
      return send(200, await rpc(db, fn, await read(), opts));
    }
    const path = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!path.startsWith(ROOT)) return send(403, {});
    return send(200, await readFile(path), TYPES[extname(path)] || 'application/octet-stream');
  } catch (e) {
    if (e.code === 'ENOENT') return send(404, { message: 'not found' });
    send(STATUS[e.code] || 500, { message: e.message, code: e.code });
  }
}).listen(PORT);
