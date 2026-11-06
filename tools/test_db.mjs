import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, rpc } from './pg.mjs';

let db, KEY, loc, loc2;
const ADMIN = '11111111-1111-1111-1111-111111111111';
const asAdmin = { role: 'authenticated', uid: ADMIN };
const iso = minsAgo => new Date(Math.floor(Date.now() / 60000) * 60000 - minsAgo * 60000).toISOString();
const row = (minsAgo, i, extra = {}) => ({ t: iso(minsAgo), i, r: [1.1, 1, 1.2, 1], tc: 29, h: 80, ...extra });
const send = (rows, key = KEY, dev = 'NODE-1') => rpc(db, 'ingest', { p_device: dev, p_key: key, p_rows: rows, p_meta: { fw: 't', rssi: -60, q: 0 } });
const q1 = async (s, a) => (await db.query(s, a)).rows;
const reset = () => db.exec(`delete from alerts; delete from events; delete from readings; delete from smell_reports; delete from device_stats; delete from net.sent; delete from private.config;`);

before(async () => {
  db = await makeDb();
  await db.query('insert into app_admins values ($1)', [ADMIN]);
  loc = await rpc(db, 'admin_save_location', { p_id: null, p_name: 'Kolej Kediaman Lestari', p_kind: 'residence', p_active: true }, asAdmin);
  loc2 = await rpc(db, 'admin_save_location', { p_id: null, p_name: 'Kolej Kediaman Lekiu (Satria)', p_kind: 'residence', p_active: true }, asAdmin);
  KEY = (await rpc(db, 'admin_save_device', { p_id: 'NODE-1', p_location: loc }, asAdmin)).key;
});

test('wrong device key is refused with 401 and stores nothing', async () => {
  await reset();
  await assert.rejects(send([row(1, 10)], 'bad-key'), e => e.code === 'PT401');
  await assert.rejects(send([row(1, 10)], KEY, 'NOPE'), e => e.code === 'PT401');
  assert.equal((await q1('select count(*)::int c from readings'))[0].c, 0);
});

test('valid readings are stored and thresholds come back to the device', async () => {
  await reset();
  const r = await send([row(1, 10)]);
  assert.equal(r.accepted, 1); assert.equal(r.noticeable, 30); assert.equal(r.strong, 60);
});

test('retrying the same batch creates no duplicates (idempotent delivery)', async () => {
  await reset();
  const batch = [row(5, 10), row(4, 11), row(3, 12)];
  assert.equal((await send(batch)).accepted, 3);
  const again = await send(batch);
  assert.equal(again.accepted, 0); assert.equal(again.duplicates, 3);
  assert.equal((await q1('select count(*)::int c from readings'))[0].c, 3);
});

test('bad values are rejected, good rows in the same batch still store', async () => {
  await reset();
  const r = await send([row(3, 150), row(2, 10, { h: 140 }), { t: 'garbage', i: 5 }, { t: new Date(Date.now() + 36e5).toISOString(), i: 5 }, row(1, 10)]);
  assert.equal(r.accepted, 1); assert.equal(r.rejected, 4);
});

test('oversized batch is refused', async () => {
  await reset();
  await assert.rejects(send(Array.from({ length: 61 }, (_, i) => row(i + 1, 5))), e => e.code === 'PT400');
});

test('a short spike does not open an event or alert', async () => {
  await reset();
  await send([row(6, 10), row(5, 90), row(4, 10), row(3, 10)]);
  assert.equal((await q1('select count(*)::int c from events'))[0].c, 0);
  assert.equal((await q1('select count(*)::int c from alerts'))[0].c, 0);
});

test('sustained odour opens one event, escalates to strong, then clears', async () => {
  await reset();
  await send([row(40, 10), row(39, 35), row(38, 36), row(37, 40)]);
  let ev = await q1('select * from events');
  assert.equal(ev.length, 1); assert.equal(ev[0].ended_at, null);
  await send([row(36, 70), row(35, 72), row(34, 75)]);
  ev = await q1('select * from events');
  assert.equal(ev.length, 1); assert.ok(ev[0].strong_at); assert.equal(Math.round(ev[0].peak_index), 75);
  await send(Array.from({ length: 12 }, (_, k) => row(33 - k, 10)));
  ev = await q1('select * from events');
  assert.ok(ev[0].ended_at, 'event should be closed');
  const kinds = (await q1('select kind from alerts order by id')).map(a => a.kind);
  assert.deepEqual(kinds, []);   // 34+ minutes old, so backfilled: nothing is announced
  assert.equal(ev[0].backfilled, true);
});

test('live event sends noticeable, strong and cleared to subscribers once each', async () => {
  await reset();
  await db.exec(`insert into private.config values ('telegram_token','T'); delete from telegram_subscribers; insert into telegram_subscribers (chat_id) values (55)`);
  await send([row(15, 35), row(14, 36), row(13, 37)]);
  await send([row(12, 70), row(11, 72), row(10, 75)]);
  await send(Array.from({ length: 10 }, (_, k) => row(9 - k, 10)));
  const a = await q1('select kind, audience, status, message from alerts order by id');
  assert.deepEqual(a.map(x => x.kind), ['noticeable', 'strong', 'cleared']);
  assert.ok(a.every(x => x.status === 'sent' && x.audience === 'public'));
  assert.equal((await q1('select count(*)::int c from net.sent'))[0].c, 3);
  assert.match(a[0].message, /Kolej Kediaman Lestari/);
});

test('alerts are skipped, not stuck, when Telegram is not configured', async () => {
  await reset();
  await send([row(4, 35), row(3, 36), row(2, 37)]);
  assert.equal((await q1(`select status from alerts`))[0].status, 'skipped');
});

test('readings during learning never open events', async () => {
  await reset();
  await send([row(4, 80, { l: true }), row(3, 80, { l: true }), row(2, 80, { l: true })]);
  assert.equal((await q1('select count(*)::int c from events'))[0].c, 0);
});

test('offline device alerts the admin once, recovery alerts once', async () => {
  await reset();
  await db.exec(`update devices set last_seen = now() - interval '20 minutes', offline_alerted = false`);
  await db.exec('select private.housekeeping()'); await db.exec('select private.housekeeping()');
  let a = await q1('select kind, audience from alerts');
  assert.deepEqual(a, [{ kind: 'offline', audience: 'admin' }]);
  await send([row(1, 5)]);
  a = await q1('select kind from alerts order by id');
  assert.deepEqual(a.map(x => x.kind), ['offline', 'online']);
});

test('summary and hourly reports count frequency and time of day', async () => {
  await reset();
  await send([row(30, 35), row(29, 36), row(28, 37), ...Array.from({ length: 12 }, (_, k) => row(27 - k, 5))]);
  const s = await rpc(db, 'get_summary', { p_from: iso(60), p_to: iso(-5) });
  assert.equal(s.events, 1); assert.equal(s.days_with_odour, 1); assert.equal(s.by_location[0].location, 'Kolej Kediaman Lestari');
  const hr = await rpc(db, 'get_hourly', { p_days: 1 });
  assert.equal(hr.length, 24);
  assert.equal(hr.reduce((n, h) => n + Number(h.noticeable_min), 0), 3);
  const ev = await rpc(db, 'get_events', { p_from: iso(60), p_to: iso(-5) });
  assert.equal(ev[0].location, 'Kolej Kediaman Lestari');
});

test('public status shows level, location and online state', async () => {
  await reset();
  await send([row(1, 65)]);
  const s = await rpc(db, 'get_status');
  const l = s.locations.find(x => x.name === 'Kolej Kediaman Lestari');
  assert.equal(l.level, 2); assert.equal(l.online, true);
  assert.equal(s.settings.calibrated, false);
  assert.equal(s.locations.find(x => x.name === 'Kolej Kediaman Lekiu (Satria)').has_device, false);
});

test('anonymous users cannot read tables or call admin functions', async () => {
  await reset();
  for (const t of ['readings', 'devices', 'alerts', 'settings']) {
    await assert.rejects(db.transaction(async tx => { await tx.exec('set local role anon'); await tx.query(`select * from public.${t}`); }), /permission denied/);
  }
  await assert.rejects(rpc(db, 'admin_overview'), /permission denied/);
  await assert.rejects(rpc(db, 'admin_overview', {}, { role: 'authenticated', uid: '22222222-2222-2222-2222-222222222222' }), e => e.code === 'PT403');
  assert.ok((await rpc(db, 'admin_overview', {}, asAdmin)).devices.length === 1);
});

test('smell reports are validated and rate limited', async () => {
  await reset();
  assert.equal((await rpc(db, 'submit_report', { p_location: loc, p_level: 1, p_note: 'x'.repeat(500) })).ok, true);
  assert.equal((await q1('select length(note) n from smell_reports'))[0].n, 200);
  await assert.rejects(rpc(db, 'submit_report', { p_location: loc, p_level: 7 }), e => e.code === 'PT400');
  for (let i = 0; i < 29; i++) await rpc(db, 'submit_report', { p_location: loc, p_level: 0 });
  await assert.rejects(rpc(db, 'submit_report', { p_location: loc, p_level: 0 }), e => e.code === 'PT429');
});

test('calibration suggests thresholds that separate smell reports', async () => {
  await reset();
  const rows = []; const reports = [];
  for (let k = 0; k < 30; k++) {
    const level = k % 3; const i = level === 0 ? 10 + (k % 5) : level === 1 ? 42 + (k % 5) : 75 + (k % 5);
    rows.push(row(30 * k + 20, i, { l: true }));
    reports.push([loc, level, iso(30 * k + 20)]);
  }
  await send(rows.slice(0, 30));
  for (const [a, b, c] of reports) await db.query('insert into smell_reports (location_id, level, created_at) values ($1,$2,$3)', [a, b, c]);
  await db.exec('update readings set learning = false');
  const c = await rpc(db, 'admin_calibration', { p_days: 30 }, asAdmin);
  assert.equal(c.pairs, 30);
  assert.ok(c.suggest_noticeable > 14 && c.suggest_noticeable <= 42, `noticeable ${c.suggest_noticeable}`);
  assert.ok(c.suggest_strong > 46 && c.suggest_strong <= 75, `strong ${c.suggest_strong}`);
  assert.equal(c.agreement_at_current, 100);
});

test('reliability report computes delivery rate, replays and gaps', async () => {
  await reset();
  // 60 expected minutes. 50 delivered; a 10-minute gap was then replayed; retry adds duplicates.
  const all = Array.from({ length: 60 }, (_, k) => row(k + 3, 5));
  const live = all.filter((_, k) => k < 20 || k >= 30);
  await send(live.slice(0, 50));
  const replay = all.slice(20, 30);
  await send(replay); await send(replay);
  const from = iso(62), to = iso(2);
  const r = await rpc(db, 'admin_reliability', { p_device: 'NODE-1', p_from: from, p_to: to }, asAdmin);
  assert.equal(r.stored, 60); assert.equal(r.duplicates_in_table, 0);
  assert.equal(r.duplicates_rejected, 10); assert.ok(r.replayed >= 58 - 3);
  assert.equal(r.delivery_pct, 100);
});

test('moving a device to a new location closes its open event and keeps its key', async () => {
  await reset();
  await send([row(4, 35), row(3, 36), row(2, 37)]);
  const res = await rpc(db, 'admin_save_device', { p_id: 'NODE-1', p_location: loc2 }, asAdmin);
  assert.equal(res.key, null);
  assert.ok((await q1('select ended_at from events'))[0].ended_at);
  assert.equal((await send([row(1, 5)])).accepted, 1);
  assert.equal((await q1('select location_id from readings order by recorded_at desc limit 1'))[0].location_id, loc2);
  await rpc(db, 'admin_save_device', { p_id: 'NODE-1', p_location: loc }, asAdmin);
});

test('map positions are saved, shown publicly, kept on a rename and range checked', async () => {
  await rpc(db, 'admin_save_location', { p_id: loc2, p_name: 'Kolej Kediaman Lekiu (Satria)', p_kind: 'residence', p_active: true, p_lat: 2.31108, p_lng: 102.3137 }, asAdmin);
  await rpc(db, 'admin_save_location', { p_id: loc2, p_name: 'Kolej Kediaman Lekiu (Satria)', p_kind: 'residence', p_active: true }, asAdmin);
  const l = (await rpc(db, 'get_status', {})).locations.find(x => x.id === loc2);
  assert.equal(l.lat, 2.31108); assert.equal(l.lng, 102.3137);
  await assert.rejects(rpc(db, 'admin_save_location', { p_id: loc2, p_name: 'x', p_kind: 'residence', p_active: true, p_lat: 95, p_lng: 102 }, asAdmin), /out of range/);
});

const update = (chat, text, type = 'private') => ({ message: { chat: { id: chat, type }, text } });
const bot = async (text, chat = 101) => rpc(db, 'telegram_update', { p_secret: 'hook', p_update: update(chat, text) });
const setBot = () => db.exec(`select private.set_telegram('TKN'); update private.config set value = 'hook' where key = 'telegram_webhook_secret'; update private.config set value = 'CODE1' where key = 'telegram_admin_code'; delete from net.sent; delete from telegram_subscribers;`);

test('bot refuses a wrong secret, ignores groups, and handles start, status and stop', async () => {
  await reset(); await setBot();
  await assert.rejects(rpc(db, 'telegram_update', { p_secret: 'nope', p_update: update(101, '/start') }), e => e.code === 'PT401');
  assert.equal(await rpc(db, 'telegram_update', { p_secret: 'hook', p_update: update(-5, '/start', 'group') }), null);
  const hi = await bot('/start');
  assert.equal(hi.method, 'sendMessage'); assert.equal(hi.chat_id, 101); assert.match(hi.text, /Kolej Kediaman Lestari/);
  assert.equal((await q1('select active from telegram_subscribers where chat_id = 101'))[0].active, true);
  assert.match((await bot('/status')).text, /Lekiu/);
  await bot('/stop');
  assert.equal((await q1('select active from telegram_subscribers where chat_id = 101'))[0].active, false);
  assert.match((await bot('hello')).text, /Commands/);
});

test('public alerts reach every active subscriber, device alerts only admins', async () => {
  await reset(); await setBot();
  await bot('/start', 201); await bot('/start', 202); await bot('/start', 203); await bot('/stop', 203);
  assert.match((await bot('/admin WRONG', 202)).text, /not right/);
  assert.match((await bot('/admin CODE1', 202)).text, /device alerts/);
  await db.exec(`select private.queue_alert('strong', 'public', ${loc}, null, 'pub'); select private.queue_alert('offline', 'admin', ${loc}, null, 'adm'); select private.flush_alerts();`);
  const sent = await q1(`select body->>'chat_id' c, body->>'text' t from net.sent order by 1, 2`);
  assert.deepEqual(sent.map(x => x.c + x.t), ['201pub', '202adm', '202pub']);
  assert.ok((await q1(`select 1 from net.sent where url like '%botTKN/sendMessage'`)).length);
});

test('a location in test mode sends no public alert but keeps device alerts, and is labelled', async () => {
  await reset(); await setBot(); await bot('/start', 301); await bot('/admin CODE1', 301);
  await assert.rejects(rpc(db, 'admin_set_test_mode', { p_location: loc, p_on: true }), e => e.code !== undefined);
  await rpc(db, 'admin_set_test_mode', { p_location: loc, p_on: true }, asAdmin);
  await db.exec(`select private.queue_alert('strong', 'public', ${loc}, null, 'pub'); select private.queue_alert('offline', 'admin', ${loc}, null, 'adm'); select private.flush_alerts();`);
  assert.deepEqual((await q1(`select body->>'text' t from net.sent`)).map(x => x.t), ['adm']);
  assert.equal((await q1(`select status from alerts where message = 'pub'`))[0].status, 'skipped');
  assert.equal((await rpc(db, 'get_status')).locations.find(l => l.id === loc).test_mode, true);
  assert.match((await bot('/status', 301)).text, /test sensor/);
  await rpc(db, 'admin_set_test_mode', { p_location: loc, p_on: false }, asAdmin);
});

test('test readings can only be cleared in test mode', async () => {
  await reset();
  await send([row(1, 5)]);
  await assert.rejects(rpc(db, 'admin_clear_test_data', { p_location: loc }, asAdmin), e => e.code === 'PT400');
  assert.equal((await q1('select count(*)::int n from readings'))[0].n, 1);
  await rpc(db, 'admin_set_test_mode', { p_location: loc, p_on: true }, asAdmin);
  assert.equal(await rpc(db, 'admin_clear_test_data', { p_location: loc }, asAdmin), 1);
  assert.equal((await q1('select count(*)::int n from readings'))[0].n, 0);
  await rpc(db, 'admin_set_test_mode', { p_location: loc, p_on: false }, asAdmin);
});

test('a command from the admin reaches the device once, and needs an admin', async () => {
  await reset();
  await assert.rejects(rpc(db, 'admin_send_command', { p_device: 'NODE-1', p_command: 'relearn' }), e => e.code !== undefined);
  await assert.rejects(rpc(db, 'admin_send_command', { p_device: 'NODE-1', p_command: 'format' }, asAdmin), e => e.code === 'PT400');
  await rpc(db, 'admin_send_command', { p_device: 'NODE-1', p_command: 'relearn' }, asAdmin);
  assert.equal((await send([row(2, 5)])).command, 'relearn');
  const again = await send([row(1, 5)]);
  assert.equal(again.command, undefined); assert.equal(again.accepted, 1);
  await rpc(db, 'admin_send_command', { p_device: 'NODE-1', p_command: 'restart' }, asAdmin);
  await assert.rejects(send([row(0, 5)], 'bad-key'), e => e.code === 'PT401');
  assert.equal((await q1(`select pending_command c from devices where id = 'NODE-1'`))[0].c, 'restart');
  await db.exec(`update devices set pending_command = null`);
});

test('anon cannot reach the private ingest or bot setup directly', async () => {
  await assert.rejects(db.transaction(async tx => { await tx.exec('set local role anon'); await tx.query(`select private.set_telegram('x')`); }));
  await assert.rejects(db.transaction(async tx => { await tx.exec('set local role anon'); await tx.query(`select private.ingest_core('a','b','[]'::jsonb,'{}'::jsonb)`); }));
});
