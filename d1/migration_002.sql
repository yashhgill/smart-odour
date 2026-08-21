-- ============================================================================
--  Migration 002 — student portal support
--
--  NOT fully idempotent. The two CREATE statements are guarded, but SQLite has
--  no "ADD COLUMN IF NOT EXISTS", so the ALTER at the end fails if this file
--  has already been applied. That failure is harmless — it means the column is
--  already there — but it will abort the batch, so check first:
--
--    wrangler d1 execute smart-odour --remote -y \
--      --command="select count(*) as n from pragma_table_info('admin_users') where name='alert_prefs'"
--
--  If that returns 1, skip the ALTER and run only the CREATE statements.
--
--  If a --file run returns {"D1_RESET_DO":true}, that is D1's import path
--  failing rather than your SQL. Run the three statements individually with
--  --command instead; see MIGRATE_002_MANUAL.md.
-- ============================================================================

create table if not exists odour_reports (
  id          text primary key,
  user_id     text references admin_users(id) on delete set null,
  zone_id     integer references zones(id) on delete set null,
  severity    text not null default 'moderate'
              check (severity in ('faint','moderate','strong','overpowering')),
  description text,
  latitude    real,
  longitude   real,
  status      text not null default 'new'
              check (status in ('new','reviewing','confirmed','dismissed')),
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  reviewed_at text,
  reviewed_by text references admin_users(id) on delete set null
);

create index if not exists idx_reports_new
  on odour_reports (created_at desc) where status = 'new';

alter table admin_users add column alert_prefs text;
