-- Background jobs. Run once in the Supabase SQL editor after 01 and 02.
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.schedule('odour-housekeeping', '* * * * *', 'select private.housekeeping()');

-- Starter locations. Pins are starting estimates: drag them to the true spot on the
-- admin page (Locations and devices). Lekiu and FTMK come from the old setup and
-- OpenStreetMap; the Lestari pin is a placeholder until someone confirms it.
insert into public.locations (name, kind, lat, lng) values
  ('North Perimeter (Farm Side)', 'farm', 2.3170, 102.3157),
  ('Kolej Kediaman Lekiu (Satria)', 'residence', 2.31108, 102.3137),
  ('Kolej Kediaman Lestari', 'residence', 2.31514, 102.31612),
  ('FTMK Faculty Building', 'other', 2.30805, 102.31887),
  ('Main Cafeteria / Waste Bay', 'other', 2.31365, 102.31892)
on conflict (name) do nothing;
