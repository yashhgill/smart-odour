-- ============================================================================
--  Seed data — four UTeM zones + 30 days of history for the three virtual nodes
--  Run AFTER schema.sql
-- ============================================================================

insert into zones (id, name, code, latitude, longitude, is_physical, description) values
  (1, 'Kolej Kediaman Lekiu',        'Z1-LEKIU',  2.3129, 102.3197, true,
     'Physical ESP32 edge node. Live telemetry via MQTT + HTTPS.'),
  (2, 'FTMK Faculty Building',       'Z2-FTMK',   2.3105, 102.3184, false,
     'Virtual node. Historical dataset replay.'),
  (3, 'Main Cafeteria / Waste Bay',  'Z3-CAFE',   2.3141, 102.3172, false,
     'Virtual node. Downwind of the campus waste collection point.'),
  (4, 'North Perimeter (Farm Side)', 'Z4-NORTH',  2.3168, 102.3210, false,
     'Virtual node. Closest to the external poultry farm boundary.')
on conflict (id) do update
  set name = excluded.name,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      is_physical = excluded.is_physical,
      description = excluded.description;

select setval(pg_get_serial_sequence('zones','id'), (select max(id) from zones));

-- ---------------------------------------------------------------------------
-- Generate 30 days of history for zones 2, 3, 4 at 15-minute resolution.
--
-- The shape is deliberately not random noise. Real odour complaints on a
-- Malaysian campus cluster around early morning (still air, temperature
-- inversion traps the plume near ground level) and again after the evening
-- waste collection. The diurnal term below reproduces that, so the AI
-- prediction module has a genuine pattern to learn instead of white noise —
-- which matters when the examiner asks what the model is actually fitting.
-- ---------------------------------------------------------------------------
insert into readings (zone_id, node_id, ts, temperature, humidity,
                      mq5, mq6, mq7_1, mq7_2, aqi_score, source)
select
  z.id,
  'VIRTUAL_' || z.code,
  t,
  -- temperature: 24-33C, peaks mid-afternoon
  26.5 + 4.0 * sin((extract(epoch from t) / 86400.0) * 2 * pi() - 1.9)
       + (random() - 0.5) * 1.4,
  -- humidity: inverse of temperature, 60-95%
  78.0 - 12.0 * sin((extract(epoch from t) / 86400.0) * 2 * pi() - 1.9)
       + (random() - 0.5) * 6.0,
  -- MQ5 (LPG / general combustible)
  greatest(150, base.mq5_base + diurnal * 120 + (random() - 0.5) * 90),
  -- MQ6 (butane / methane, tracks organic decomposition)
  greatest(150, base.mq6_base + diurnal * 180 + (random() - 0.5) * 110),
  -- MQ7 #1 (CO)
  greatest(100, base.mq7_base + diurnal * 95  + (random() - 0.5) * 70),
  -- MQ7 #2 (CO, redundant sensor — slight offset by design)
  greatest(100, base.mq7_base + diurnal * 95  + (random() - 0.5) * 70 + 18),
  -- composite odour index 0-100
  least(100, greatest(0, base.aqi_base + diurnal * 32 + (random() - 0.5) * 12)),
  'seed'
from generate_series(now() - interval '30 days', now(), interval '15 minutes') as t
cross join lateral (
  -- two daily peaks: ~06:00 (inversion) and ~19:00 (waste collection)
  select
    greatest(
      exp(-power(extract(hour from t) + extract(minute from t)/60.0 - 6.0,  2) / 6.0),
      exp(-power(extract(hour from t) + extract(minute from t)/60.0 - 19.0, 2) / 8.0) * 0.85
    ) as diurnal
) d
cross join (values
    (2, 380.0, 420.0, 260.0, 28.0),
    (3, 460.0, 610.0, 300.0, 41.0),
    (4, 520.0, 720.0, 330.0, 52.0)
  ) as base(id, mq5_base, mq6_base, mq7_base, aqi_base)
join zones z on z.id = base.id
where not exists (
  select 1 from readings r where r.zone_id = base.id and r.source = 'seed'
);

-- ---------------------------------------------------------------------------
-- A couple of historical incidents so the console is not empty on day one
-- ---------------------------------------------------------------------------
insert into incidents (zone_id, kind, severity, metric, value, threshold, message,
                       opened_at, acknowledged_at, acknowledged_by, resolved_at)
values
  (4, 'threshold', 'critical', 'mq6', 892, 750,
   'Sustained methane/butane spike at North Perimeter — likely upwind farm activity.',
   now() - interval '6 days',  now() - interval '6 days'  + interval '9 minutes',
   'facility@utem.edu.my', now() - interval '6 days' + interval '2 hours'),
  (3, 'threshold', 'warning', 'mq7_1', 468, 400,
   'Elevated CO near cafeteria waste bay during evening collection window.',
   now() - interval '2 days',  now() - interval '2 days' + interval '14 minutes',
   'facility@utem.edu.my', now() - interval '2 days' + interval '50 minutes')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Sanity check
-- ---------------------------------------------------------------------------
select z.code,
       z.is_physical,
       count(r.id)   as readings,
       min(r.ts)     as oldest,
       max(r.ts)     as newest
from zones z
left join readings r on r.zone_id = z.id
group by z.id, z.code, z.is_physical
order by z.id;
