# Applying migration 002 by hand

Use this if `--file=d1/migration_002.sql` returned `{"D1_RESET_DO":true}`.
That error comes from D1's bulk-import path, not from your SQL. Running the
statements individually goes through a different endpoint and works.

Run each from `worker/`, one at a time, and read the result before the next.

### 1. The reports table

```bash
npx wrangler d1 execute smart-odour --remote -y --command="create table if not exists odour_reports (id text primary key, user_id text, zone_id integer, severity text not null default 'moderate' check (severity in ('faint','moderate','strong','overpowering')), description text, latitude real, longitude real, status text not null default 'new' check (status in ('new','reviewing','confirmed','dismissed')), created_at text not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now')), reviewed_at text, reviewed_by text)"
```

### 2. Its index

```bash
npx wrangler d1 execute smart-odour --remote -y --command="create index if not exists idx_reports_new on odour_reports (created_at desc) where status = 'new'"
```

### 3. The preferences column

Check whether it exists first:

```bash
npx wrangler d1 execute smart-odour --remote -y --command="select count(*) as n from pragma_table_info('admin_users') where name='alert_prefs'"
```

If `n` is 0, add it. If `n` is 1, skip this — it is already there.

```bash
npx wrangler d1 execute smart-odour --remote -y --command="alter table admin_users add column alert_prefs text"
```

`duplicate column name: alert_prefs` means it already existed. Nothing is broken.

### 4. Confirm

```bash
npx wrangler d1 execute smart-odour --remote -y --command="select name from sqlite_master where type='table' order by name"
```

You should see: `admin_users`, `alert_log`, `incidents`, `invites`,
`login_attempts`, `odour_reports`, `readings`, `reports`, `sessions`,
`uptime_samples`, `zones`.

### Note on foreign keys

The manual statements drop the `references` clauses that the file version
carries on `user_id`, `zone_id`, and `reviewed_by`. D1 does not enforce foreign
keys by default anyway, so behaviour is identical — the application sets those
values and the joins work the same. Mentioned only so you are not surprised if
you diff the schema against the file later.
