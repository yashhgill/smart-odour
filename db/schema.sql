-- ============================================================================
--  Smart Odour Monitoring Platform — Supabase / Postgres schema
--  Run this in the Supabase SQL editor before seed.sql
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- ZONES  (replaces the RDS relational tier)
-- ---------------------------------------------------------------------------
create table if not exists zones (
  id            serial primary key,
  name          text        not null,
  code          text        not null unique,
  latitude      double precision not null,
  longitude     double precision not null,
  is_physical   boolean     not null default false,   -- true only for Zone 1
  description   text,
  created_at    timestamptz not null default now()
);

comment on column zones.is_physical is
  'TRUE = real ESP32 hardware. FALSE = virtual node replayed from historical data. '
  'Surface this flag in the UI so the four-zone view is honest.';

-- ---------------------------------------------------------------------------
-- READINGS  (replaces DynamoDB)
-- ---------------------------------------------------------------------------
create table if not exists readings (
  id            bigserial primary key,
  zone_id       int         not null references zones(id) on delete cascade,
  node_id       text        not null default 'VIRTUAL',
  ts            timestamptz not null default now(),
  temperature   real,
  humidity      real,
  mq5           real,
  mq6           real,
  mq7_1         real,
  mq7_2         real,
  aqi_score     real,          -- derived composite odour index, 0-100
  rssi          int,
  source        text        not null default 'live'   -- live | replay | seed
    check (source in ('live','replay','seed'))
);

create index if not exists idx_readings_zone_ts on readings (zone_id, ts desc);
create index if not exists idx_readings_ts      on readings (ts desc);

-- ---------------------------------------------------------------------------
-- INCIDENTS  (threshold breaches + infrastructure failovers)
-- ---------------------------------------------------------------------------
create table if not exists incidents (
  id            uuid primary key default gen_random_uuid(),
  zone_id       int         references zones(id) on delete set null,
  kind          text        not null            -- threshold | failover | node_offline
    check (kind in ('threshold','failover','node_offline')),
  severity      text        not null default 'warning'
    check (severity in ('info','warning','critical')),
  metric        text,                            -- e.g. 'mq7_1'
  value         real,
  threshold     real,
  message       text        not null,
  opened_at     timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by text,
  resolved_at   timestamptz
);

create index if not exists idx_incidents_open on incidents (opened_at desc)
  where resolved_at is null;

-- ---------------------------------------------------------------------------
-- UPTIME SAMPLES  (the reliability-pillar evidence table)
-- Written every minute by the Cloudflare Worker cron probe.
-- ---------------------------------------------------------------------------
create table if not exists uptime_samples (
  id            bigserial primary key,
  ts            timestamptz not null default now(),
  origin        text        not null,            -- primary | standby
  healthy       boolean     not null,
  latency_ms    int,
  status_code   int
);

create index if not exists idx_uptime_ts on uptime_samples (ts desc);
create index if not exists idx_uptime_origin_ts on uptime_samples (origin, ts desc);

-- ---------------------------------------------------------------------------
-- ALERT LOG  (what SNS used to do)
-- ---------------------------------------------------------------------------
create table if not exists alert_log (
  id            bigserial primary key,
  incident_id   uuid references incidents(id) on delete cascade,
  channel       text not null,                   -- email | telegram
  target        text,
  ok            boolean not null,
  detail        text,
  sent_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- REPORTS  (ESG PDFs archived in R2, metadata here)
-- ---------------------------------------------------------------------------
create table if not exists reports (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  period_start  timestamptz not null,
  period_end    timestamptz not null,
  r2_key        text not null,
  generated_at  timestamptz not null default now(),
  generated_by  text
);

-- ---------------------------------------------------------------------------
-- ADMIN USERS  (replaces the RDS credential store)
-- ---------------------------------------------------------------------------
create table if not exists admin_users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  full_name     text,
  role          text not null default 'facility'
    check (role in ('facility','admin','viewer')),
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- VIEWS
-- ---------------------------------------------------------------------------

-- Latest reading per zone — powers the dashboard tiles and the GIS heatmap.
create or replace view v_latest_readings as
select distinct on (r.zone_id)
       r.zone_id, z.name as zone_name, z.code, z.latitude, z.longitude,
       z.is_physical, r.ts, r.temperature, r.humidity,
       r.mq5, r.mq6, r.mq7_1, r.mq7_2, r.aqi_score, r.source
from readings r
join zones z on z.id = r.zone_id
order by r.zone_id, r.ts desc;

-- Rolling 24h uptime per origin — the number on the reliability panel.
create or replace view v_uptime_24h as
select origin,
       count(*)                                            as samples,
       count(*) filter (where healthy)                     as healthy_samples,
       round(100.0 * count(*) filter (where healthy) / nullif(count(*),0), 2)
                                                           as uptime_pct,
       round(avg(latency_ms) filter (where healthy))       as avg_latency_ms
from uptime_samples
where ts > now() - interval '24 hours'
group by origin;

-- ---------------------------------------------------------------------------
-- ACCESS MODEL
-- Neon has no PostgREST layer and no anon key, so the database is never
-- exposed to the browser. Only the Render backend and the Cloudflare Worker
-- hold the connection string, and both keep it in secret storage. That makes
-- row level security unnecessary here: there is no untrusted client to
-- constrain. If you ever point a browser directly at the database, add RLS
-- before you do.
--
-- Create a least-privilege role for the Worker, which only ever inserts:
--
--   create role odour_writer login password '<generated>';
--   grant insert on readings, incidents, alert_log, uptime_samples to odour_writer;
--   grant usage, select on all sequences in schema public to odour_writer;
-- ---------------------------------------------------------------------------
