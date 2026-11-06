// Spins up an in-memory Postgres with the stubs Supabase normally provides,
// then loads the real SQL files. Used by the tests and the local dev server.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const sql = f => readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8');
export async function makeDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create schema net;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    create table net.sent (url text, body jsonb);
    create function net.http_post(url text, body jsonb, headers jsonb) returns bigint language sql as
      $$ insert into net.sent values (url, body); select 1::bigint $$;
    grant usage on schema net to anon, authenticated;
    grant usage on schema public to anon, authenticated;
  `);
  await db.exec(sql('01_schema.sql'));
  await db.exec(sql('02_functions.sql'));
  await db.exec(sql('04_bot_and_control.sql'));
  return db;
}
// Calls a function the way the REST API would: as a given role, with named args.
export async function rpc(db, fn, args = {}, { role = 'anon', uid = '' } = {}) {
  const names = Object.keys(args);
  const q = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  const vals = names.map(n => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]));
  return db.transaction(async tx => {
    await tx.query(`select set_config('test.uid', $1, true)`, [uid]);
    await tx.exec(`set local role ${role}`);
    const res = await tx.query(q, vals);
    await tx.exec('reset role');
    return res.rows[0]?.r;
  });
}
