-- Smart Odour Monitoring System: Telegram bot subscriptions, test mode and commands to devices.
-- Run after 01, 02 and 03.

alter table public.locations add column test_mode boolean not null default false;
alter table public.devices add column pending_command text;

create table public.telegram_subscribers (
  chat_id    bigint primary key,
  active     boolean not null default true,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.telegram_subscribers enable row level security;

-- ---------------------------------------------------------------- alerts go to everyone who pressed Start
-- A location in test mode never alerts the public, because its sensor is not really there.
create or replace function private.flush_alerts() returns int
language plpgsql security definer set search_path = '' as $$
declare v_token text; a record; c record; n int := 0; v_sent int;
begin
  select value into v_token from private.config where key = 'telegram_token';
  for a in select al.id, al.audience, al.message, coalesce(l.test_mode, false) as test
           from public.alerts al left join public.locations l on l.id = al.location_id
           where al.status = 'pending' order by al.id limit 20 loop
    v_sent := 0;
    if v_token is not null and not (a.test and a.audience = 'public') then
      for c in select chat_id from public.telegram_subscribers
               where active and (a.audience = 'public' or is_admin) loop
        perform net.http_post(
          url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
          body := jsonb_build_object('chat_id', c.chat_id, 'text', a.message),
          headers := '{"Content-Type":"application/json"}'::jsonb);
        v_sent := v_sent + 1;
      end loop;
    end if;
    if v_sent = 0 then
      update public.alerts set status = 'skipped' where id = a.id;
    else
      update public.alerts set status = 'sent', sent_at = now() where id = a.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------- bot
-- Plain-word status of every shown location, for /status and the welcome message.
create function private.status_text() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(string_agg(t.line, E'\n' order by t.name), 'No locations set up yet.') from (
    select l.name, l.name || ': ' || case
        when d.id is null then 'no sensor yet'
        when d.last_seen is null or d.last_seen <= now() - make_interval(secs => s.sample_seconds * 3) then 'sensor offline'
        when r.learning then 'learning clean air'
        when r.odour_index >= s.strong then 'STRONG'
        when r.odour_index >= s.noticeable then 'Noticeable'
        when r.id is null then 'waiting for a reading'
        else 'Normal' end
      || case when l.test_mode then ' (test sensor, not on campus yet)' else '' end as line
    from public.locations l
    cross join public.settings s
    left join lateral (select * from public.devices x where x.location_id = l.id order by x.last_seen desc nulls last limit 1) d on true
    left join lateral (select * from public.readings x where x.location_id = l.id order by x.recorded_at desc limit 1) r on true
    where l.active and s.id = 1
  ) t
$$;

-- Called by the webhook in functions/api/telegram.js. The answer is sent straight back to
-- Telegram as the webhook's reply, so the website itself never holds the bot token.
create function public.telegram_update(p_secret text, p_update jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_secret text; v_chat bigint; v_text text; v_cmd text; v_arg text; v_reply text;
begin
  select value into v_secret from private.config where key = 'telegram_webhook_secret';
  if v_secret is null or p_secret is distinct from v_secret then
    raise sqlstate 'PT401' using message = 'wrong webhook secret';
  end if;
  if p_update #>> '{message,chat,type}' is distinct from 'private' then return null; end if;
  v_chat := (p_update #>> '{message,chat,id}')::bigint;
  v_text := btrim(coalesce(p_update #>> '{message,text}', ''));
  v_cmd  := lower(split_part(split_part(v_text, ' ', 1), '@', 1));
  v_arg  := btrim(split_part(v_text, ' ', 2));

  if v_cmd = '/start' then
    insert into public.telegram_subscribers (chat_id) values (v_chat)
    on conflict (chat_id) do update set active = true;
    v_reply := E'You will now get odour alerts for the UTeM campus.\n\n' || private.status_text()
      || E'\n\nSend /status any time, or /stop to turn alerts off.';
  elsif v_cmd = '/stop' then
    update public.telegram_subscribers set active = false where chat_id = v_chat;
    v_reply := 'Alerts are off. Send /start to turn them back on.';
  elsif v_cmd = '/status' then
    v_reply := private.status_text();
  elsif v_cmd = '/admin' then
    if v_arg <> '' and v_arg = (select value from private.config where key = 'telegram_admin_code') then
      insert into public.telegram_subscribers (chat_id, is_admin) values (v_chat, true)
      on conflict (chat_id) do update set is_admin = true, active = true;
      v_reply := 'This chat will now also get device alerts, such as a sensor going offline.';
    else
      v_reply := 'That code is not right.';
    end if;
  else
    v_reply := E'Commands:\n/status  current air at each location\n/start  turn alerts on\n/stop  turn alerts off';
  end if;
  return jsonb_build_object('method', 'sendMessage', 'chat_id', v_chat, 'text', v_reply);
end $$;

-- Run this in the SQL editor: select private.set_telegram('TOKEN');
-- Saves the token and points the bot at the website. Run it again after revoking a token.
create function private.set_telegram(p_token text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_secret text := replace(gen_random_uuid()::text, '-', '');
        v_code text := upper(left(replace(gen_random_uuid()::text, '-', ''), 8));
begin
  insert into private.config (key, value) values
    ('telegram_token', btrim(p_token)), ('telegram_webhook_secret', v_secret), ('telegram_admin_code', v_code)
  on conflict (key) do update set value = excluded.value;
  perform net.http_post(
    url := 'https://api.telegram.org/bot' || btrim(p_token) || '/setWebhook',
    body := jsonb_build_object('url', 'https://smart-odour.pages.dev/api/telegram', 'secret_token', v_secret,
                               'allowed_updates', jsonb_build_array('message'), 'drop_pending_updates', true),
    headers := '{"Content-Type":"application/json"}'::jsonb);
  perform net.http_post(
    url := 'https://api.telegram.org/bot' || btrim(p_token) || '/setMyCommands',
    body := jsonb_build_object('commands', jsonb_build_array(
      jsonb_build_object('command', 'status', 'description', 'Current air at each location'),
      jsonb_build_object('command', 'start', 'description', 'Turn alerts on'),
      jsonb_build_object('command', 'stop', 'description', 'Turn alerts off'))),
    headers := '{"Content-Type":"application/json"}'::jsonb);
  return 'Saved. To get device alerts too, send this to the bot: /admin ' || v_code;
end $$;

-- ---------------------------------------------------------------- commands to a device
-- The firmware has no open port, so a command waits here and travels back in the reply to the next upload.
alter function public.ingest(text, text, jsonb, jsonb) rename to ingest_core;
alter function public.ingest_core(text, text, jsonb, jsonb) set schema private;

create function public.ingest(p_device text, p_key text, p_rows jsonb, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_cmd text;
begin
  v := private.ingest_core(p_device, p_key, p_rows, p_meta);   -- refuses a wrong key
  update public.devices d set pending_command = null
  from (select id, pending_command from public.devices where id = p_device) o
  where d.id = o.id returning o.pending_command into v_cmd;
  return case when v_cmd is null then v else v || jsonb_build_object('command', v_cmd) end;
end $$;

create function public.admin_send_command(p_device text, p_command text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if p_command not in ('relearn', 'restart') then
    raise sqlstate 'PT400' using message = 'unknown command';
  end if;
  update public.devices set pending_command = p_command where id = p_device;
  if not found then raise sqlstate 'PT400' using message = 'unknown device'; end if;
end $$;

-- ---------------------------------------------------------------- test mode
create function public.admin_set_test_mode(p_location int, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  update public.locations set test_mode = p_on where id = p_location;
  if not found then raise sqlstate 'PT400' using message = 'unknown location'; end if;
end $$;

-- Only works in test mode, so real history can never be wiped by accident.
create function public.admin_clear_test_data(p_location int) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_admin();
  if not exists (select 1 from public.locations where id = p_location and test_mode) then
    raise sqlstate 'PT400' using message = 'turn on test mode first';
  end if;
  delete from public.alerts where location_id = p_location;
  delete from public.events where location_id = p_location;
  delete from public.readings where location_id = p_location;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- the pages also need these fields
create or replace function public.get_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'settings', (select jsonb_build_object('noticeable', noticeable, 'strong', strong,
                  'calibrated', calibrated_at is not null, 'sample_seconds', sample_seconds)
                 from public.settings where id = 1),
    'server_time', now(),
    'locations', coalesce(jsonb_agg(row_to_json(t) order by t.kind = 'farm' desc, t.name), '[]'::jsonb))
  from (
    select l.id, l.name, l.kind, l.lat, l.lng, l.test_mode, r.recorded_at, r.odour_index, r.level, r.temperature, r.humidity, r.learning,
           d.id is not null as has_device,
           coalesce(d.last_seen > now() - make_interval(secs => (select sample_seconds * 3 from public.settings)), false) as online,
           e.started_at as event_started_at, e.strong_at as event_strong_at
    from public.locations l
    left join lateral (select * from public.devices x where x.location_id = l.id order by x.last_seen desc nulls last limit 1) d on true
    left join lateral (select * from public.readings x where x.location_id = l.id order by x.recorded_at desc limit 1) r on true
    left join public.events e on e.location_id = l.id and e.ended_at is null
    where l.active
  ) t
$$;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from public.settings s where id = 1),
    'locations', (select coalesce(jsonb_agg(to_jsonb(l) order by l.name), '[]'::jsonb) from public.locations l),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'location_id', d.location_id,
        'last_seen', d.last_seen, 'firmware', d.firmware, 'rssi', d.rssi, 'queued', d.queued,
        'offline', d.offline_alerted, 'pending_command', d.pending_command) order by d.id), '[]'::jsonb) from public.devices d),
    'alerts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id desc), '[]'::jsonb)
               from (select * from public.alerts order by id desc limit 30) a),
    'telegram_configured', exists (select 1 from private.config where key = 'telegram_token'),
    'telegram_subscribers', (select count(*) from public.telegram_subscribers where active));
end $$;

-- ---------------------------------------------------------------- who may call what
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.ingest(text, text, jsonb, jsonb) from public;
revoke all on function public.telegram_update(text, jsonb) from public;
revoke all on function public.admin_send_command(text, text) from public, anon;
revoke all on function public.admin_set_test_mode(int, boolean) from public, anon;
revoke all on function public.admin_clear_test_data(int) from public, anon;
grant execute on function public.ingest(text, text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.telegram_update(text, jsonb) to anon, authenticated;
grant execute on function public.admin_send_command(text, text) to authenticated;
grant execute on function public.admin_set_test_mode(int, boolean) to authenticated;
grant execute on function public.admin_clear_test_data(int) to authenticated;
