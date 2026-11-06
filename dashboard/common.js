// Shared by both pages. Talks to Supabase over plain fetch, so there is no SDK or build step.
const C = window.CONFIG;
const token = () => { try { return sessionStorage.getItem('odour_token') || ''; } catch { return ''; } };
// With DEMO_DATA on there is no database: answers come from a saved simulated snapshot, moved to the present.
let demo = null;
function loadDemo() {
  return demo || (demo = new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'demo-data.js'; s.onload = () => ok(window.DEMO_SNAPSHOT); s.onerror = no; document.head.append(s); }));
}
async function demoRpc(fn, a) {
  const D = await loadDemo(), shift = Date.now() - new Date(D.at).getTime();
  const near = () => { const d = a.p_days || Math.round((new Date(a.p_to) - new Date(a.p_from)) / 864e5); return `${a.p_location ?? null}|${[7, 30, 90].reduce((x, y) => Math.abs(y - d) < Math.abs(x - d) ? y : x)}`; };
  const pick = { get_status: () => D.status, get_trend: () => D.trend[a.p_location] || [], get_hourly: () => D.hourly[near()], get_summary: () => D.summary[near()],
    get_events: () => D.events[near()].slice(0, a.p_limit || 100), admin_overview: () => D.overview, admin_calibration: () => D.calibration, admin_reliability: () => D.reliability, admin_readings: () => [] }[fn];
  if (!pick) throw new Error('Changes are not saved in this demonstration.');
  const move = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(new Date(v).getTime() + shift).toISOString()
    : Array.isArray(v) ? v.map(move) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, move(x)])) : v;
  return move(pick());
}
async function rpc(fn, args = {}, auth = false) {
  if (C.DEMO_DATA) return demoRpc(fn, args);
  const res = await fetch(`${C.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: C.SUPABASE_KEY,
      Authorization: 'Bearer ' + (auth && token() ? token() : C.SUPABASE_KEY) },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(body?.message || 'Request failed'); e.status = res.status; throw e; }
  return body;
}
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TZ = 'Asia/Kuala_Lumpur';
const fmtTime = t => t ? new Date(t).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }) : '–';
const fmtDate = t => t ? new Date(t).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', timeZone: TZ }) : '–';
const LEVELS = ['Normal', 'Noticeable', 'Strong'];
const LOGO = `<img class="logo l" src="assets/logo-light-mark.png" alt="Smart Odour"><img class="logo d" src="assets/logo-dark-mark.png" alt="Smart Odour">`;
// Light and dark. Follows the device until the visitor chooses.
function themeNow() { const t = document.documentElement.dataset.theme; return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
function themeButton(el) {
  const label = () => { el.textContent = themeNow() === 'dark' ? 'Light mode' : 'Dark mode'; };
  // Pin the current look first, so "auto" never flips the logo on its own after this.
  document.documentElement.dataset.theme = themeNow();
  label();
  el.onclick = () => { const n = themeNow() === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = n; try { localStorage.setItem('odour_theme', n); } catch {} label(); };
}
const hourLabel = h => String(h).padStart(2, '0') + ':00';
const klHour = d => Number(new Date(d).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ })) % 24;

// Hour-of-day bars: minutes of noticeable and strong odour, stacked.
function hoursChart(el, rows) {
  const total = rows.reduce((n, r) => n + Number(r.noticeable_min) + Number(r.strong_min), 0);
  if (!total) { el.innerHTML = '<div class="empty">No odour recorded in this period.</div>'; return; }
  const W = 720, H = 170, B = 20, T = 6, max = Math.max(...rows.map(r => Number(r.noticeable_min) + Number(r.strong_min)));
  const bw = W / 24, y = v => (v / max) * (H - B - T);
  let s = `<svg class="hours" viewBox="0 0 ${W} ${H}" role="img" aria-label="Minutes of odour for each hour of the day">`;
  [[0, 7], [19, 24]].forEach(([a, b]) => { s += `<rect x="${a * bw}" y="0" width="${(b - a) * bw}" height="${H - B}" fill="var(--night)" opacity=".5"/>`; });
  rows.forEach(r => {
    const x = r.hour * bw + 3, w = bw - 6, n = y(Number(r.noticeable_min)), st = y(Number(r.strong_min));
    s += `<g><title>${hourLabel(r.hour)}: ${r.noticeable_min} min noticeable, ${r.strong_min} min strong</title>`;
    s += `<rect x="${x}" y="${H - B - n}" width="${w}" height="${n}" fill="var(--noticeable)"/><rect x="${x}" y="${H - B - n - st}" width="${w}" height="${st}" fill="var(--strong)"/></g>`;
    if (r.hour % 3 === 0) s += `<text x="${r.hour * bw + bw / 2}" y="${H - 5}" text-anchor="middle" font-size="12" fill="var(--soft)">${String(r.hour).padStart(2, '0')}</text>`;
  });
  el.innerHTML = s + '</svg>';
}
