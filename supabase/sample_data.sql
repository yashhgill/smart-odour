-- Sample readings for checking the website with data at every location.
-- Every sample row belongs to a device whose id starts with SAMPLE-, so it can be removed completely.
--
--   select private.seed_sample(6);   -- 6 days of readings for each location that has no real device
--   select private.clear_sample();   -- removes every SAMPLE- device, reading, event and alert
--
-- Clear the samples before collecting results for the report, so that only real readings remain.

create or replace function private.seed_sample(p_days int default 6) returns text
language plpgsql security definer set search_path = '' as $$
declare
  l record; v_dev text; v_prof text; v_t timestamptz; v_rows jsonb; v_total int := 0; v_places int := 0;
  v_start timestamptz := date_trunc('minute', now()) - make_interval(days => least(p_days, 6));
  v_midnight timestamptz; ep_at timestamptz[]; ep_len real[]; ep_pk real[];
  d int; k int; v_hr real; v_base real; v_idx real; v_shape real; v_tc real; v_h real; v_r real;
begin
  perform setseed(0.42);
  for l in select * from public.locations x where x.active
             and not exists (select 1 from public.devices y where y.location_id = x.id and y.id not like 'SAMPLE-%')
           order by x.id loop
    v_dev := 'SAMPLE-' || l.id;
    insert into public.devices (id, key_hash, location_id) values (v_dev, sha256(convert_to('sample', 'UTF8')), l.id)
    on conflict (id) do update set location_id = excluded.location_id;
    v_prof := case when l.name ilike '%farm%' or l.name ilike '%perimeter%' then 'farm'
                   when l.name ilike '%lestari%' then 'near'
                   when l.name ilike '%cafe%' then 'cafe' else 'far' end;

    -- One possible odour episode a day: at night from the farm side, around lunch at the cafeteria.
    ep_at := '{}'; ep_len := '{}'; ep_pk := '{}';
    for d in 0 .. least(p_days, 6) + 1 loop
      v_midnight := (date_trunc('day', (v_start at time zone 'Asia/Kuala_Lumpur')) + make_interval(days => d)) at time zone 'Asia/Kuala_Lumpur';
      if random() < (case v_prof when 'farm' then .85 when 'near' then .55 when 'cafe' then .7 else .2 end) then
        ep_at := ep_at || (v_midnight + make_interval(secs => (case v_prof when 'cafe' then 11.5 + random() * 2.5 else 21 + random() * 8 end * 3600)::int));
        ep_len := ep_len || (case v_prof when 'farm' then 30 + random() * 60 when 'near' then 20 + random() * 40 when 'cafe' then 30 + random() * 30 else 15 + random() * 15 end)::real;
        ep_pk := ep_pk || (case v_prof when 'farm' then 45 + random() * 40 when 'near' then 32 + random() * 28 when 'cafe' then 30 + random() * 20 else 30 + random() * 10 end)::real;
      end if;
    end loop;

    v_rows := '[]'; v_t := v_start;
    while v_t < now() - interval '1 minute' loop
      v_hr := extract(hour from v_t at time zone 'Asia/Kuala_Lumpur') + extract(minute from v_t at time zone 'Asia/Kuala_Lumpur') / 60;
      v_base := case v_prof when 'farm' then 8 when 'near' then 6 when 'cafe' then 5 else 3 end + random() * 4;
      v_idx := v_base;
      for k in 1 .. coalesce(array_length(ep_at, 1), 0) loop
        -- No episode in the last two hours, so nothing is left open and no alert goes out.
        if ep_at[k] < now() - interval '2 hours' and v_t >= ep_at[k] and v_t < ep_at[k] + make_interval(mins => ep_len[k]::int) then
          v_shape := sin(pi() * extract(epoch from v_t - ep_at[k]) / (ep_len[k] * 60));
          v_idx := greatest(v_idx, ep_pk[k] * v_shape + random() * 3);
        end if;
      end loop;
      v_idx := least(100, greatest(0, v_idx));
      v_tc := 27 + 4 * sin(2 * pi() * (v_hr - 9) / 24) + random() * 0.6;
      v_h := least(98, 78 - 12 * sin(2 * pi() * (v_hr - 9) / 24) + random() * 3);
      v_r := 1 + v_idx / 50;
      v_rows := v_rows || jsonb_build_object('t', to_char(v_t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'i', round(v_idx::numeric, 1), 'tc', round(v_tc::numeric, 1), 'h', round(v_h::numeric), 'l', false,
        'r', jsonb_build_array(round((v_r * (0.9 + random() * 0.2))::numeric, 2), round((v_r * (0.9 + random() * 0.2))::numeric, 2),
                               round((v_r * (0.9 + random() * 0.2))::numeric, 2), round((v_r * (0.9 + random() * 0.2))::numeric, 2)));
      if jsonb_array_length(v_rows) = 60 then
        perform private.ingest_core(v_dev, 'sample', v_rows, '{"fw":"sample"}'::jsonb);
        v_total := v_total + 60; v_rows := '[]';
      end if;
      v_t := v_t + interval '2 minutes';
    end loop;
    if jsonb_array_length(v_rows) > 0 then
      perform private.ingest_core(v_dev, 'sample', v_rows, '{"fw":"sample"}'::jsonb);
      v_total := v_total + jsonb_array_length(v_rows);
    end if;
    update public.devices set offline_alerted = true where id = v_dev;   -- no "device offline" message for samples
    v_places := v_places + 1;
  end loop;
  delete from public.alerts a using public.devices x
  where a.location_id = x.location_id and x.id like 'SAMPLE-%' and a.created_at >= now();
  return format('Added %s sample readings at %s locations.', v_total, v_places);
end $$;

create or replace function private.clear_sample() returns text
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.alerts where event_id in (select id from public.events where device_id like 'SAMPLE-%');
  delete from public.events where device_id like 'SAMPLE-%';
  delete from public.readings where device_id like 'SAMPLE-%';
  get diagnostics n = row_count;
  delete from public.device_stats where device_id like 'SAMPLE-%';
  delete from public.devices where id like 'SAMPLE-%';
  return format('Removed %s sample readings.', n);
end $$;

revoke all on function private.seed_sample(int) from public, anon, authenticated;
revoke all on function private.clear_sample() from public, anon, authenticated;
