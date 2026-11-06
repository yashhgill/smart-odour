-- Smart Odour Monitoring System: all application logic.
-- Sections: helpers, device ingest, event detection, alerts, public API, admin API.

-- ---------------------------------------------------------------- helpers
create function private.level_of(p_index real) returns smallint
language sql stable set search_path = '' as $$
  select case when p_index >= s.strong then 2 when p_index >= s.noticeable then 1 else 0 end::smallint
  from public.settings s where s.id = 1
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins a where a.user_id = auth.uid())
$$;

create function private.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise sqlstate 'PT403' using message = 'admin only';
  end if;
end $$;

create function private.klt(p timestamptz) returns text
language sql immutable set search_path = '' as $$
  select to_char(p at time zone 'Asia/Kuala_Lumpur', 'HH24:MI')
$$;

-- ---------------------------------------------------------------- alerts
create function private.queue_alert(p_kind text, p_audience text, p_location int, p_event bigint, p_message text)
returns void language sql set search_path = '' as $$
  insert into public.alerts (kind, audience, location_id, event_id, message)
  values (p_kind, p_audience, p_location, p_event, p_message)
$$;

-- Sends pending alerts to Telegram through pg_net. With no token configured the
-- alerts are marked skipped, so everything else still works.
create function private.flush_alerts() returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_token text; v_public text; v_admin text; v_chat text; a record; n int := 0;
begin
  select value into v_token  from private.config where key = 'telegram_token';
  select value into v_public from private.config where key = 'telegram_public_chat';
  select value into v_admin  from private.config where key = 'telegram_admin_chat';
  for a in select * from public.alerts where status = 'pending' order by id limit 20 loop
    v_chat := case a.audience when 'public' then v_public else v_admin end;
    if v_token is null or v_chat is null then
      update public.alerts set status = 'skipped' where id = a.id;
    else
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
        body := jsonb_build_object('chat_id', v_chat, 'text', a.message),
        headers := '{"Content-Type":"application/json"}'::jsonb);
      update public.alerts set status = 'sent', sent_at = now() where id = a.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------- event detection
-- Called once per stored reading, oldest first.
-- OPEN   : every reading in the last open_minutes is at or above noticeable.
-- STRONG : every reading in the last open_minutes is at or above strong.
-- CLOSE  : nothing at or above noticeable for clear_minutes.
-- A brief spike therefore never becomes an event or an alert.
create function private.process_reading(p_device text, p_location int, p_at timestamptz, p_index real)
returns void language plpgsql set search_path = '' as $$
declare
  s public.settings; ev public.events; v_loc text;
  v_min real; v_n int; v_first timestamptz; v_live boolean; v_cool boolean;
begin
  select * into s from public.settings where id = 1;
  select name into v_loc from public.locations where id = p_location;
  select * into ev from public.events where location_id = p_location and ended_at is null;
  v_live := now() - p_at < interval '15 minutes';

  select min(odour_index), count(*), min(recorded_at) into v_min, v_n, v_first
  from public.readings
  where device_id = p_device and not learning
    and recorded_at > p_at - make_interval(mins => s.open_minutes) and recorded_at <= p_at;

  if ev.id is null then
    if v_n >= 2 and v_min >= s.noticeable then
      insert into public.events (location_id, device_id, started_at, last_above_at, peak_index, peak_at, backfilled)
      values (p_location, p_device, v_first, p_at, p_index, p_at, not v_live)
      returning * into ev;
      select not exists (
        select 1 from public.alerts a where a.location_id = p_location and a.audience = 'public'
          and a.kind in ('noticeable','strong')
          and a.created_at > now() - make_interval(mins => s.cooldown_minutes)) into v_cool;
      if v_live and v_cool then
        perform private.queue_alert('noticeable', 'public', p_location, ev.id,
          'Odour noticed at ' || v_loc || ' since ' || private.klt(v_first) || '. Level: NOTICEABLE.');
      end if;
    else
      return;
    end if;
  end if;

  if p_index >= s.noticeable then
    update public.events set
      last_above_at = greatest(last_above_at, p_at),
      peak_at = case when p_index > peak_index then p_at else peak_at end,
      peak_index = greatest(peak_index, p_index)
    where id = ev.id;
  end if;

  if ev.strong_at is null and v_n >= 2 and v_min >= s.strong then
    update public.events set strong_at = p_at where id = ev.id;
    if v_live then
      perform private.queue_alert('strong', 'public', p_location, ev.id,
        'STRONG odour at ' || v_loc || ' (' || private.klt(p_at) || '). Close windows if you can.');
    end if;
  end if;

  select * into ev from public.events where id = ev.id;
  if p_at - ev.last_above_at >= make_interval(mins => s.clear_minutes) then
    update public.events set ended_at = last_above_at where id = ev.id;
    if v_live and exists (select 1 from public.alerts a where a.event_id = ev.id) then
      perform private.queue_alert('cleared', 'public', p_location, ev.id,
        'Odour at ' || v_loc || ' has cleared (' || private.klt(ev.last_above_at) || ').');
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------- device ingest
-- POST /rest/v1/rpc/ingest. Rows look like:
--   {"t":"2026-11-07T13:00:00Z","i":12.5,"r":[1.1,1.0,1.2,1.0],"tc":29.0,"h":81,"l":false}
-- The unique (device_id, recorded_at) key makes a retry harmless: a row the
-- server already holds is counted as a duplicate and acknowledged.
create function public.ingest(p_device text, p_key text, p_rows jsonb, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d public.devices; s public.settings; x jsonb; v_at timestamptz; v_i real;
  v_tc real; v_h real; v_id bigint; v_learn boolean; v_replay boolean;
  n_ok int := 0; n_dup int := 0; n_bad int := 0; n_replay int := 0;
begin
  select * into d from public.devices where id = p_device;
  if d.id is null or d.key_hash <> sha256(convert_to(coalesce(p_key,''), 'UTF8')) then
    raise sqlstate 'PT401' using message = 'unknown device or wrong key';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 60 then
    raise sqlstate 'PT400' using message = 'rows must be an array of at most 60';
  end if;
  select * into s from public.settings where id = 1;

  for x in select value from jsonb_array_elements(p_rows) order by value->>'t' loop
    begin
      v_at := (x->>'t')::timestamptz;
      v_i  := (x->>'i')::real;
      v_tc := (x->>'tc')::real;
      v_h  := (x->>'h')::real;
      v_learn := coalesce((x->>'l')::boolean, false);
    exception when others then
      n_bad := n_bad + 1; continue;
    end;
    if v_at is null or v_i is null or v_i < 0 or v_i > 100
       or v_at > now() + interval '5 minutes' or v_at < now() - interval '7 days'
       or (v_tc is not null and (v_tc < -10 or v_tc > 70))
       or (v_h  is not null and (v_h  < 0   or v_h  > 100)) then
      n_bad := n_bad + 1; continue;
    end if;
    v_replay := now() - v_at > make_interval(secs => s.sample_seconds * 2);
    insert into public.readings (device_id, location_id, recorded_at, odour_index, level,
                                 r1, r2, r3, r4, temperature, humidity, learning, replayed)
    values (d.id, d.location_id, v_at, v_i, private.level_of(v_i),
            (x->'r'->>0)::real, (x->'r'->>1)::real, (x->'r'->>2)::real, (x->'r'->>3)::real,
            v_tc, v_h, v_learn, v_replay)
    on conflict (device_id, recorded_at) do nothing
    returning id into v_id;
    if v_id is null then
      n_dup := n_dup + 1;
    else
      n_ok := n_ok + 1;
      if v_replay then n_replay := n_replay + 1; end if;
      if not v_learn then
        perform private.process_reading(d.id, d.location_id, v_at, v_i);
      end if;
    end if;
    v_id := null;
  end loop;

  update public.devices set last_seen = now(), firmware = coalesce(p_meta->>'fw', firmware),
    rssi = coalesce((p_meta->>'rssi')::int, rssi), queued = coalesce((p_meta->>'q')::int, queued)
  where id = d.id;

  if d.offline_alerted then
    update public.devices set offline_alerted = false where id = d.id;
    perform private.queue_alert('online', 'admin', d.location_id, null, 'Device ' || d.id || ' is back online.');
  end if;

  insert into public.device_stats (device_id, day, accepted, duplicates, rejected, replayed)
  values (d.id, (now() at time zone 'Asia/Kuala_Lumpur')::date, n_ok, n_dup, n_bad, n_replay)
  on conflict (device_id, day) do update set
    accepted = public.device_stats.accepted + excluded.accepted,
    duplicates = public.device_stats.duplicates + excluded.duplicates,
    rejected = public.device_stats.rejected + excluded.rejected,
    replayed = public.device_stats.replayed + excluded.replayed;

  perform private.flush_alerts();
  -- The reply carries the current thresholds, so the LCD status matches the dashboard.
  return jsonb_build_object('accepted', n_ok, 'duplicates', n_dup, 'rejected', n_bad,
                            'noticeable', s.noticeable, 'strong', s.strong);
end $$;

-- Runs every minute from pg_cron: closes events for silent devices, flags offline devices.
create function private.housekeeping() returns void
language plpgsql security definer set search_path = '' as $$
declare s public.settings; d record;
begin
  select * into s from public.settings where id = 1;
  update public.events e set ended_at = e.last_above_at
  where e.ended_at is null and now() - e.last_above_at > interval '60 minutes';
  for d in select * from public.devices
           where not offline_alerted and last_seen is not null
             and now() - last_seen > make_interval(secs => s.sample_seconds * 5) loop
    update public.devices set offline_alerted = true where id = d.id;
    perform private.queue_alert('offline', 'admin', d.location_id, null,
      'Device ' || d.id || ' has stopped reporting (last seen ' || private.klt(d.last_seen) || ').');
  end loop;
  perform private.flush_alerts();
end $$;

-- ---------------------------------------------------------------- public API (no login)
-- Current status of every location, the first thing a student sees.
create function public.get_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'settings', (select jsonb_build_object('noticeable', noticeable, 'strong', strong,
                  'calibrated', calibrated_at is not null, 'sample_seconds', sample_seconds)
                 from public.settings where id = 1),
    'server_time', now(),
    'locations', coalesce(jsonb_agg(row_to_json(t) order by t.kind = 'farm' desc, t.name), '[]'::jsonb))
  from (
    select l.id, l.name, l.kind, l.lat, l.lng, r.recorded_at, r.odour_index, r.level, r.temperature, r.humidity, r.learning,
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

-- Odour index over time, averaged into buckets so charts stay light.
create function public.get_trend(p_location int, p_hours int default 24) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('t', b, 'i', round(i::numeric,1), 'max', round(m::numeric,1), 'tc', round(tc::numeric,1), 'h', round(h::numeric,0)) order by b), '[]'::jsonb)
  from (
    select to_timestamp(floor(extract(epoch from recorded_at) / (w.secs)) * w.secs) as b,
           avg(odour_index) as i, max(odour_index) as m, avg(temperature) as tc, avg(humidity) as h
    from public.readings,
         lateral (select greatest(60, least(p_hours, 720) * 15)::int as secs) w
    where location_id = p_location and not learning
      and recorded_at > now() - make_interval(hours => least(p_hours, 720))
    group by 1
  ) q
$$;

-- WHEN does it happen: minutes of odour per hour of day, in Malaysian time.
create function public.get_hourly(p_location int default null, p_days int default 30) returns jsonb
language sql stable security definer set search_path = '' as $$
  with s as (select noticeable, strong, sample_seconds from public.settings where id = 1)
  select jsonb_agg(jsonb_build_object('hour', h, 'noticeable_min', coalesce(n,0), 'strong_min', coalesce(st,0)) order by h)
  from generate_series(0,23) h
  left join (
    select extract(hour from r.recorded_at at time zone 'Asia/Kuala_Lumpur')::int as hr,
           round(count(*) filter (where r.odour_index >= s.noticeable and r.odour_index < s.strong) * s.sample_seconds / 60.0) as n,
           round(count(*) filter (where r.odour_index >= s.strong) * s.sample_seconds / 60.0) as st
    from public.readings r, s
    where not r.learning and r.recorded_at > now() - make_interval(days => least(p_days, 365))
      and (p_location is null or r.location_id = p_location)
    group by 1, s.sample_seconds
  ) x on x.hr = h
$$;

-- HOW OFTEN: totals for a date range, overall and per location.
create function public.get_summary(p_from timestamptz, p_to timestamptz, p_location int default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  with e as (
    select ev.*, extract(epoch from coalesce(ev.ended_at, ev.last_above_at) - ev.started_at) / 60 as mins
    from public.events ev
    where ev.started_at >= p_from and ev.started_at < p_to
      and (p_location is null or ev.location_id = p_location)
  ), per_day as (
    select (started_at at time zone 'Asia/Kuala_Lumpur')::date as d, count(*) c,
           count(*) filter (where strong_at is not null) sc from e group by 1
  )
  select jsonb_build_object(
    'events', (select count(*) from e),
    'strong_events', (select count(*) from e where strong_at is not null),
    'total_minutes', (select coalesce(round(sum(mins)),0) from e),
    'avg_minutes', (select coalesce(round(avg(mins)),0) from e),
    'days_with_odour', (select count(*) from per_day),
    'peak_index', (select max(peak_index) from e),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'events', c, 'strong', sc) order by d), '[]'::jsonb) from per_day),
    'by_location', (select coalesce(jsonb_agg(jsonb_build_object('location', l.name, 'events', x.c, 'strong', x.sc, 'minutes', x.m) order by x.c desc), '[]'::jsonb)
       from (select location_id, count(*) c, count(*) filter (where strong_at is not null) sc, round(sum(mins)) m from e group by 1) x
       join public.locations l on l.id = x.location_id))
$$;

create function public.get_events(p_from timestamptz, p_to timestamptz, p_location int default null, p_limit int default 100)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_to_json(t) order by t.started_at desc), '[]'::jsonb) from (
    select e.id, l.name as location, e.started_at, e.ended_at, round(e.peak_index::numeric,1) as peak_index,
           e.strong_at is not null as strong, e.backfilled,
           round(extract(epoch from coalesce(e.ended_at, e.last_above_at) - e.started_at) / 60) as minutes
    from public.events e join public.locations l on l.id = e.location_id
    where e.started_at >= p_from and e.started_at < p_to
      and (p_location is null or e.location_id = p_location)
    order by e.started_at desc limit least(p_limit, 1000)
  ) t
$$;

-- "I can smell it" form. Capped per location per hour so it cannot be flooded.
create function public.submit_report(p_location int, p_level int, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_level not in (0,1,2) then raise sqlstate 'PT400' using message = 'level must be 0, 1 or 2'; end if;
  if not exists (select 1 from public.locations where id = p_location and active) then
    raise sqlstate 'PT400' using message = 'unknown location';
  end if;
  if (select count(*) from public.smell_reports where location_id = p_location
      and created_at > now() - interval '1 hour') >= 30 then
    raise sqlstate 'PT429' using message = 'too many reports, try again later';
  end if;
  insert into public.smell_reports (location_id, level, note)
  values (p_location, p_level, nullif(left(btrim(p_note), 200), ''));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- admin API (login required)
create function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from public.settings s where id = 1),
    'locations', (select coalesce(jsonb_agg(to_jsonb(l) order by l.name), '[]'::jsonb) from public.locations l),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'location_id', d.location_id,
        'last_seen', d.last_seen, 'firmware', d.firmware, 'rssi', d.rssi, 'queued', d.queued,
        'offline', d.offline_alerted) order by d.id), '[]'::jsonb) from public.devices d),
    'alerts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id desc), '[]'::jsonb)
               from (select * from public.alerts order by id desc limit 30) a),
    'telegram_configured', (select count(*) >= 2 from private.config where key in ('telegram_token','telegram_public_chat')));
end $$;

create function public.admin_set_thresholds(p_noticeable real, p_strong real) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if p_noticeable <= 0 or p_strong <= p_noticeable or p_strong > 100 then
    raise sqlstate 'PT400' using message = 'need 0 < noticeable < strong <= 100';
  end if;
  update public.settings set noticeable = p_noticeable, strong = p_strong, calibrated_at = now() where id = 1;
end $$;

create function public.admin_save_location(p_id int, p_name text, p_kind text, p_active boolean,
                                           p_lat double precision default null, p_lng double precision default null) returns int
language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  perform private.require_admin();
  if (p_lat is not null and p_lat not between -90 and 90) or (p_lng is not null and p_lng not between -180 and 180) then
    raise exception 'Map position is out of range' using errcode = 'PT400';
  end if;
  if p_id is null then
    insert into public.locations (name, kind, active, lat, lng) values (p_name, p_kind, p_active, p_lat, p_lng) returning id into v;
  else
    update public.locations set name = p_name, kind = p_kind, active = p_active,
           lat = coalesce(p_lat, lat), lng = coalesce(p_lng, lng)   -- leaving these out keeps the pin where it is
     where id = p_id returning id into v;
  end if;
  return v;
end $$;

-- Creates a device or moves it. A key is returned only when created or rotated.
create function public.admin_save_device(p_id text, p_location int, p_rotate boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_key text := null; v_exists boolean;
begin
  perform private.require_admin();
  select exists (select 1 from public.devices where id = p_id) into v_exists;
  if not v_exists or p_rotate then
    v_key := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  end if;
  if not v_exists then
    insert into public.devices (id, key_hash, location_id)
    values (p_id, sha256(convert_to(v_key, 'UTF8')), p_location);
  else
    update public.devices set location_id = p_location,
      key_hash = case when p_rotate then sha256(convert_to(v_key, 'UTF8')) else key_hash end
    where id = p_id;
    update public.events set ended_at = last_above_at where device_id = p_id and ended_at is null;
  end if;
  return jsonb_build_object('id', p_id, 'key', v_key);
end $$;

-- Pairs each smell report with the sensor index around that moment, then finds
-- the threshold that best separates "people smell it" from "they do not"
-- (highest sensitivity + specificity - 1). This turns "which is good and which
-- is bad" into a measured answer.
create function public.admin_calibration(p_days int default 60) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require_admin();
  with pairs as (
    select sr.id, sr.level, sr.created_at, l.name as location, x.i
    from public.smell_reports sr
    join public.locations l on l.id = sr.location_id
    join lateral (select avg(r.odour_index) as i from public.readings r
                  where r.location_id = sr.location_id and not r.learning
                    and r.recorded_at between sr.created_at - interval '5 minutes' and sr.created_at + interval '5 minutes') x on x.i is not null
    where sr.created_at > now() - make_interval(days => p_days)
  ), cand as (select generate_series(5, 95, 5)::real as t),
  scored as (
    select c.t,
      count(*) filter (where p.level >= 1 and p.i >= c.t) as tp1, count(*) filter (where p.level >= 1) as pos1,
      count(*) filter (where p.level = 0 and p.i < c.t) as tn1, count(*) filter (where p.level = 0) as neg1,
      count(*) filter (where p.level = 2 and p.i >= c.t) as tp2, count(*) filter (where p.level = 2) as pos2,
      count(*) filter (where p.level < 2 and p.i < c.t) as tn2, count(*) filter (where p.level < 2) as neg2
    from cand c cross join pairs p group by c.t
  ), j as (
    select t, tp1, pos1, tn1, neg1,
      case when pos1 > 0 and neg1 > 0 then tp1::real/pos1 + tn1::real/neg1 - 1 end as j1,
      case when pos2 > 0 and neg2 > 0 then tp2::real/pos2 + tn2::real/neg2 - 1 end as j2
    from scored
  )
  select jsonb_build_object(
    'pairs', (select count(*) from pairs),
    'no_smell', (select count(*) from pairs where level = 0),
    'noticeable', (select count(*) from pairs where level = 1),
    'strong', (select count(*) from pairs where level = 2),
    'avg_index', (select jsonb_object_agg(level, a) from (select level, round(avg(i)::numeric,1) a from pairs group by level) z),
    'suggest_noticeable', (select t from j where j1 is not null order by j1 desc, t limit 1),
    'suggest_strong', (select t from j where j2 is not null order by j2 desc, t limit 1),
    'agreement_at_current', (
      select round(100.0 * count(*) filter (where (p.level >= 1) = (p.i >= s.noticeable)) / nullif(count(*),0), 1)
      from pairs p, public.settings s),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('t', created_at, 'location', location, 'level', level, 'index', round(i::numeric,1)) order by created_at desc), '[]'::jsonb)
             from (select * from pairs order by created_at desc limit 50) r)
  ) into v;
  return v;
end $$;

-- Delivery evidence for the reliability evaluation.
create function public.admin_reliability(p_device text, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; s public.settings;
begin
  perform private.require_admin();
  select * into s from public.settings where id = 1;
  with r as (
    select recorded_at, replayed, received_at,
           lag(recorded_at) over (order by recorded_at) as prev
    from public.readings where device_id = p_device and recorded_at >= p_from and recorded_at < p_to
  ), expected as (select greatest(1, floor(extract(epoch from p_to - p_from) / s.sample_seconds))::bigint as n)
  select jsonb_build_object(
    'expected', (select n from expected),
    'stored', (select count(*) from r),
    'delivery_pct', round(100.0 * (select count(*) from r) / (select n from expected), 2),
    'replayed', (select count(*) from r where replayed),
    'duplicates_in_table', (select count(*) - count(distinct recorded_at) from r),
    'duplicates_rejected', (select coalesce(sum(duplicates),0) from public.device_stats where device_id = p_device
                            and day between (p_from at time zone 'Asia/Kuala_Lumpur')::date and (p_to at time zone 'Asia/Kuala_Lumpur')::date),
    'rejected', (select coalesce(sum(rejected),0) from public.device_stats where device_id = p_device
                            and day between (p_from at time zone 'Asia/Kuala_Lumpur')::date and (p_to at time zone 'Asia/Kuala_Lumpur')::date),
    'longest_gap_minutes', (select round(max(extract(epoch from recorded_at - prev))/60.0, 1) from r),
    'max_recovery_minutes', (select round(max(extract(epoch from received_at - recorded_at))/60.0, 1) from r),
    'median_delay_seconds', (select round(percentile_cont(0.5) within group (order by extract(epoch from received_at - recorded_at))::numeric, 1) from r)
  ) into v;
  return v;
end $$;

create function public.admin_readings(p_location int, p_from timestamptz, p_to timestamptz, p_limit int default 20000)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require_admin();
  select coalesce(jsonb_agg(to_jsonb(t) order by t.recorded_at), '[]'::jsonb) into v from (
    select device_id, recorded_at, odour_index, level, r1, r2, r3, r4, temperature, humidity, replayed
    from public.readings where location_id = p_location and recorded_at >= p_from and recorded_at < p_to
    order by recorded_at limit least(p_limit, 50000)) t;
  return v;
end $$;

-- ---------------------------------------------------------------- access
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
revoke usage on schema private from public, anon, authenticated;
grant execute on function public.ingest(text, text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.get_status() to anon, authenticated;
grant execute on function public.get_trend(int, int) to anon, authenticated;
grant execute on function public.get_hourly(int, int) to anon, authenticated;
grant execute on function public.get_summary(timestamptz, timestamptz, int) to anon, authenticated;
grant execute on function public.get_events(timestamptz, timestamptz, int, int) to anon, authenticated;
grant execute on function public.submit_report(int, int, text) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_set_thresholds(real, real) to authenticated;
grant execute on function public.admin_save_location(int, text, text, boolean, double precision, double precision) to authenticated;
grant execute on function public.admin_save_device(text, int, boolean) to authenticated;
grant execute on function public.admin_calibration(int) to authenticated;
grant execute on function public.admin_reliability(text, timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_readings(int, timestamptz, timestamptz, int) to authenticated;
