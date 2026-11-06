-- Smart Odour Monitoring System: tables.
-- Every table has row level security ON and no policies. Browsers and devices
-- can only reach data through the functions in 02_functions.sql.

create schema if not exists private;

create table public.locations (
  id         serial primary key,
  name       text not null unique,
  kind       text not null default 'residence' check (kind in ('farm','residence','other')),
  active     boolean not null default true,
  lat        double precision check (lat between -90 and 90),    -- map position
  lng        double precision check (lng between -180 and 180),
  created_at timestamptz not null default now()
);

create table public.devices (
  id             text primary key,
  key_hash       bytea not null,
  location_id    int not null references public.locations(id),
  created_at     timestamptz not null default now(),
  last_seen      timestamptz,
  firmware       text,
  rssi           int,
  queued         int,
  offline_alerted boolean not null default false
);

-- A single row of tunable values. Thresholds start provisional until the
-- calibration page has enough human smell reports to suggest real ones.
create table public.settings (
  id             int primary key default 1 check (id = 1),
  noticeable     real not null default 30,
  strong         real not null default 60,
  open_minutes   int  not null default 3,
  clear_minutes  int  not null default 10,
  sample_seconds int  not null default 60,
  cooldown_minutes int not null default 30,
  calibrated_at  timestamptz
);
insert into public.settings (id) values (1);

create table public.readings (
  id          bigserial primary key,
  device_id   text not null references public.devices(id),
  location_id int  not null references public.locations(id),
  recorded_at timestamptz not null,
  received_at timestamptz not null default now(),
  odour_index real not null,
  level       smallint not null,
  r1 real, r2 real, r3 real, r4 real,
  temperature real,
  humidity    real,
  learning    boolean not null default false,
  replayed    boolean not null default false,
  unique (device_id, recorded_at)
);
create index readings_location_time on public.readings (location_id, recorded_at desc);

-- Delivery counters per device per day, used by the reliability evaluation.
create table public.device_stats (
  device_id  text not null references public.devices(id),
  day        date not null,
  accepted   int not null default 0,
  duplicates int not null default 0,
  rejected   int not null default 0,
  replayed   int not null default 0,
  primary key (device_id, day)
);

-- An odour event: a sustained period at or above "noticeable".
create table public.events (
  id            bigserial primary key,
  location_id   int not null references public.locations(id),
  device_id     text not null references public.devices(id),
  started_at    timestamptz not null,
  ended_at      timestamptz,
  last_above_at timestamptz not null,
  peak_index    real not null,
  peak_at       timestamptz not null,
  strong_at     timestamptz,
  backfilled    boolean not null default false
);
create index events_location_time on public.events (location_id, started_at desc);
create unique index one_open_event_per_location on public.events (location_id) where ended_at is null;

-- What people actually smell. This is the ground truth used for calibration.
create table public.smell_reports (
  id          bigserial primary key,
  location_id int not null references public.locations(id),
  created_at  timestamptz not null default now(),
  level       smallint not null check (level in (0,1,2)),
  note        text
);
create index smell_reports_location_time on public.smell_reports (location_id, created_at desc);

create table public.alerts (
  id          bigserial primary key,
  kind        text not null check (kind in ('noticeable','strong','cleared','offline','online')),
  audience    text not null check (audience in ('public','admin')),
  location_id int references public.locations(id),
  event_id    bigint references public.events(id),
  message     text not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  status      text not null default 'pending' check (status in ('pending','sent','skipped'))
);

create table public.app_admins (user_id uuid primary key);

-- Telegram token and chat ids. Lives outside the API-exposed schema.
create table private.config (key text primary key, value text not null);

alter table public.locations     enable row level security;
alter table public.devices       enable row level security;
alter table public.settings      enable row level security;
alter table public.readings      enable row level security;
alter table public.device_stats  enable row level security;
alter table public.events        enable row level security;
alter table public.smell_reports enable row level security;
alter table public.alerts        enable row level security;
alter table public.app_admins    enable row level security;
