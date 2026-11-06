import { makeDb, rpc } from './pg.mjs';
const db = await makeDb();
await db.query(`insert into app_admins values ('11111111-1111-1111-1111-111111111111')`);
const a = { role: 'authenticated', uid: '11111111-1111-1111-1111-111111111111' };
const l = await rpc(db, 'admin_save_location', { p_id: null, p_name: 'x', p_kind: 'other', p_active: true }, a);
const { key } = await rpc(db, 'admin_save_device', { p_id: 'N', p_location: l }, a);
const now = Math.floor(Date.now() / 6e4) * 6e4, N = 7 * 1440;
for (let k = 0; k < N; k += 60) {
  const rows = Array.from({ length: 60 }, (_, i) => ({ t: new Date(now - (k + i) * 6e4).toISOString(), i: 7.4, r: [1.1, 1, 1.2, 1], tc: 29.1, h: 80 }));
  await rpc(db, 'ingest', { p_device: 'N', p_key: key, p_rows: rows, p_meta: { fw: '2.0.0', rssi: -60, q: 0 } });
}
const r = (await db.query(`select count(*)::int c, pg_total_relation_size('readings') b from readings`)).rows[0];
const perRow = r.b / r.c;
console.log(JSON.stringify({ rows: r.c, bytes: Number(r.b), bytesPerRow: +perRow.toFixed(0), mbPerNodePerYear: +(perRow * 525600 / 1048576).toFixed(0) }));
