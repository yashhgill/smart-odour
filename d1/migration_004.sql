-- ============================================================================
--  Migration 004 — Telegram subscribers
--
--  Alerts previously went to one chat id held in a Worker secret. That works
--  for a single group but cannot fan out, and adding a recipient meant a
--  redeploy. Subscribers now live here: anyone who sends /start to the bot is
--  registered, and /stop removes them.
--
--    wrangler d1 execute smart-odour --remote -y --file=d1/migration_004.sql
-- ============================================================================

create table if not exists telegram_subscribers (
  chat_id      text primary key,          -- negative for groups, positive for DMs
  chat_type    text not null default 'private',
  title        text,                      -- group name, or the person's name
  subscribed_at text not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  active       integer not null default 1,
  -- Minimum severity this chat wants. A facilities group probably wants
  -- everything; a supervisor's DM probably only wants critical.
  min_severity text not null default 'warning'
               check (min_severity in ('warning','critical')),
  last_error   text,
  last_sent_at text
);

create index if not exists idx_tg_active
  on telegram_subscribers (active) where active = 1;
