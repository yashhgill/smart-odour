-- ============================================================================
--  Migration 003 — forecast storage
--
--  Predictions are computed on Render (scikit-learn cannot run on Workers) and
--  posted back here. Storing them means the dashboard reads forecasts from the
--  edge at D1 speed, and a cold Render instance never blocks a page load.
--
--  NOT idempotent past the first run: the CREATE statements are guarded, but
--  re-running is harmless.
--
--    wrangler d1 execute smart-odour --remote -y --file=d1/migration_003.sql
-- ============================================================================

create table if not exists predictions (
  id           text primary key,
  zone_id      integer not null references zones(id) on delete cascade,
  generated_at text not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  horizon_min  integer not null,          -- minutes ahead this point refers to
  predicted    real    not null,          -- odour index, 0-100
  lower        real,                      -- uncertainty band
  upper        real,
  model        text    not null,          -- 'random_forest' | 'linear_trend' | 'insufficient_data'
  r2           real,                      -- fit quality on held-out data, may be null
  n_samples    integer,                   -- how many readings the fit used
  features     text                       -- JSON: relative feature importance
);

create index if not exists idx_pred_zone_time
  on predictions (zone_id, generated_at desc);

-- Rolling record of each fitting run, so the AI page can show when the model
-- last ran and whether it succeeded, rather than silently showing stale numbers.
create table if not exists model_runs (
  id           text primary key,
  started_at   text not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at  text,
  ok           integer not null default 0,
  model        text,
  zones_fitted integer default 0,
  duration_ms  integer,
  detail       text
);

create index if not exists idx_model_runs on model_runs (started_at desc);
