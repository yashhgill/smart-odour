// Saves the local simulated server's answers to dashboard/demo-data.js, so the site can be
// shown with labelled simulated data before Supabase exists. Needs: node dev_server.mjs 8787
import { writeFile } from 'node:fs/promises';
const BASE = 'http://localhost:8787/rest/v1/rpc/';
const call = async (fn, args = {}, admin = false) => {
  const r = await fetch(BASE + fn, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: 'Bearer admin-token' } : {}) }, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(fn + ' ' + r.status); return r.json();
};
const iso = ms => new Date(ms).toISOString(), now = Date.now();
const status = await call('get_status');
const ids = [null, ...status.locations.map(l => l.id)], D = { at: iso(now), status, trend: {}, hourly: {}, summary: {}, events: {}, readings: {} };
for (const l of status.locations) D.trend[l.id] = await call('get_trend', { p_location: l.id, p_hours: 24 });
for (const days of [7, 30, 90]) for (const id of ids) {
  const k = `${id}|${days}`, f = iso(now - days * 864e5), t = iso(now + 6e4);
  D.hourly[k] = await call('get_hourly', { p_location: id, p_days: days });
  D.summary[k] = await call('get_summary', { p_from: f, p_to: t, p_location: id });
  D.events[k] = await call('get_events', { p_from: f, p_to: t, p_location: id, p_limit: 500 });
}
D.overview = await call('admin_overview', {}, true);
D.calibration = await call('admin_calibration', { p_days: 90 }, true);
D.reliability = await call('admin_reliability', { p_device: D.overview.devices[0].id, p_from: iso(now - 72 * 36e5), p_to: iso(now) }, true);
await writeFile(new URL('../dashboard/demo-data.js', import.meta.url), 'window.DEMO_SNAPSHOT=' + JSON.stringify(D) + ';\n');
console.log('saved demo-data.js');
