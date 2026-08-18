-- ============================================================================
--  Smart Odour Monitoring — Cloudflare D1 schema (SQLite dialect)
--
--  Differences from the Postgres version, and why:
--    * timestamps are TEXT in ISO-8601 UTC. SQLite has no timestamptz, and
--      ISO-8601 sorts correctly as a string, so range queries still work.
--    * ids are TEXT hex instead of uuid. D1 has no gen_random_uuid().
--    * "distinct on" does not exist, so v_latest_readings uses a window
--      function, which SQLite has supported since 3.25.
--    * booleans are INTEGER 0/1.
--
--  Apply with:  wrangler d1 execute smart-odour --remote --file=d1/schema.sql
-- ============================================================================

create table if not exists zones (
  id           integer primary key,
  name         text    not null,
  code         text    not null unique,
  latitude     real    not null,
  longitude    real    not null,
  is_physical  integer not null default 0,      -- 1 only for Zone 1 hardware
  description  text,
  created_at   text    not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

create table if not exists readings (
  id          integer primary key autoincrement,
  zone_id     integer not null references zones(id) on delete cascade,
  node_id     text    not null default 'VIRTUAL',
  ts          text    not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  temperature real,
  humidity    real,
  mq5         real,
  mq6         real,
  mq7_1       real,
  mq7_2       real,
  aqi_score   real,                              -- composite odour index 0-100
  rssi        integer,
  seq         integer,                           -- monotonic counter from node
  source      text    not null default 'live'
              check (source in ('live','replay','seed'))
);

create index if not exists idx_readings_zone_ts on readings (zone_id, ts desc);
create index if not exists idx_readings_ts      on readings (ts desc);

-- Replay-safe: a node emptying its offline buffer resends rows it already
-- delivered. This makes the duplicate a no-op instead of a double count.
create unique index if not exists idx_readings_node_seq
  on readings (node_id, seq) where seq is not null;

create table if not exists incidents (
  id              text    primary key,
  zone_id         integer references zones(id) on delete set null,
  kind            text    not null
                  check (kind in ('threshold','failover','node_offline')),
  severity        text    not null default 'warning'
                  check (severity in ('info','warning','critical')),
  metric          text,
  value           real,
  threshold       real,
  message         text    not null,
  opened_at       text    not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  acknowledged_at text,
  acknowledged_by text,
  resolved_at     text
);

create index if not exists idx_incidents_open
  on incidents (opened_at desc) where resolved_at is null;

create table if not exists uptime_samples (
  id          integer primary key autoincrement,
  ts          text    not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  origin      text    not null,                  -- edge | d1 | ingest
  healthy     integer not null,
  latency_ms  integer,
  status_code integer
);

create index if not exists idx_uptime_ts        on uptime_samples (ts desc);
create index if not exists idx_uptime_origin_ts on uptime_samples (origin, ts desc);

create table if not exists alert_log (
  id          integer primary key autoincrement,
  incident_id text references incidents(id) on delete cascade,
  channel     text    not null,                  -- email | telegram
  target      text,
  ok          integer not null,
  detail      text,
  sent_at     text    not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

create table if not exists reports (
  id           text primary key,
  title        text not null,
  period_start text not null,
  period_end   text not null,
  r2_key       text not null,
  generated_at text not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  generated_by text
);

create table if not exists admin_users (
  id            text primary key,
  email         text not null unique,
  password_hash text not null,
  full_name     text,
  role          text not null default 'facility'
                check (role in ('facility','admin','viewer')),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============================================================================
--  AUTHENTICATION
--
--  Password hashing is PBKDF2-SHA256 via WebCrypto, because Workers have no
--  bcrypt or argon2. Stored as  pbkdf2$<iterations>$<salt_b64>$<hash_b64>  so
--  the iteration count can be raised later without invalidating old hashes.
--
--  Sessions are opaque random tokens, not JWTs. A JWT cannot be revoked before
--  it expires; a row in this table can be deleted the instant someone leaves.
-- ============================================================================

create table if not exists sessions (
  id         text primary key,              -- SHA-256 of the cookie value
  user_id    text not null references admin_users(id) on delete cascade,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at text not null,
  user_agent text,
  ip         text
);

create index if not exists idx_sessions_user    on sessions (user_id);
create index if not exists idx_sessions_expires on sessions (expires_at);

-- Invite-only registration. There is deliberately no open signup route:
-- an admin panel anyone can register for is not an admin panel.
create table if not exists invites (
  code       text primary key,
  role       text not null default 'viewer'
             check (role in ('facility','admin','viewer')),
  created_by text references admin_users(id) on delete set null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at text not null,
  used_at    text,
  used_by    text references admin_users(id) on delete set null
);

create index if not exists idx_invites_unused on invites (expires_at) where used_at is null;

-- Failed logins, for lockout and for showing an audit trail in the viva.
create table if not exists login_attempts (
  id         integer primary key autoincrement,
  email      text not null,
  ip         text,
  ok         integer not null,
  at         text not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

create index if not exists idx_login_attempts on login_attempts (email, at desc);

-- Latest reading per zone. SQLite has no DISTINCT ON, so rank and filter.
drop view if exists v_latest_readings;
create view v_latest_readings as
select zone_id, zone_name, code, latitude, longitude, is_physical,
       ts, temperature, humidity, mq5, mq6, mq7_1, mq7_2, aqi_score, source
from (
  select r.zone_id, z.name as zone_name, z.code, z.latitude, z.longitude,
         z.is_physical, r.ts, r.temperature, r.humidity,
         r.mq5, r.mq6, r.mq7_1, r.mq7_2, r.aqi_score, r.source,
         row_number() over (partition by r.zone_id order by r.ts desc) as rn
  from readings r
  join zones z on z.id = r.zone_id
)
where rn = 1;

drop view if exists v_uptime_24h;
create view v_uptime_24h as
select origin,
       count(*)                                        as samples,
       sum(case when healthy = 1 then 1 else 0 end)    as healthy_samples,
       round(100.0 * sum(case when healthy = 1 then 1 else 0 end)
             / max(count(*), 1), 2)                    as uptime_pct,
       round(avg(case when healthy = 1 then latency_ms end))
                                                       as avg_latency_ms
from uptime_samples
where ts > strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours')
group by origin;
