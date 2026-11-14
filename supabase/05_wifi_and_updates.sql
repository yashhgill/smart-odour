-- Smart Odour Monitoring System: change the sensor's Wi-Fi and update its firmware from the admin page.
-- Run after 01 to 04. Commands travel to the device in the reply to its next upload, as before.
--
-- Commands (stored as JSON text in devices.pending_command):
--   {"cmd":"scan"}                                    list the Wi-Fi networks the sensor can see
--   {"cmd":"wifi_add","ssid":"..","pass":"..","now":true}   save a network; with now, try it at once
--                                                     and fall back to the old network if it fails
--   {"cmd":"wifi_forget","ssid":".."}                 remove a saved network
--   {"cmd":"update","url":"..","sha256":"..","version":".."}   download new firmware and install it

alter table public.devices
  add column wifi_ssid text,            -- the network it is on now
  add column wifi_saved jsonb,          -- names of the networks it has saved (never the passwords)
  add column wifi_scan jsonb,           -- the last scan: [{"s": name, "r": signal dBm, "e": needs password}]
  add column wifi_scan_at timestamptz,
  add column last_report text,          -- the device's answer to the last command
  add column last_report_at timestamptz;

-- The device also reports its Wi-Fi state and command results in p_meta.
create or replace function public.ingest(p_device text, p_key text, p_rows jsonb, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_cmd text; m jsonb := coalesce(p_meta, '{}'::jsonb);
begin
  v := private.ingest_core(p_device, p_key, p_rows, m);   -- refuses a wrong key
  update public.devices set
    wifi_ssid      = coalesce(m->>'ssid', wifi_ssid),
    wifi_saved     = coalesce(m->'saved', wifi_saved),
    wifi_scan      = case when m ? 'scan' then m->'scan' else wifi_scan end,
    wifi_scan_at   = case when m ? 'scan' then now() else wifi_scan_at end,
    last_report    = case when m ? 'report' then left(m->>'report', 200) else last_report end,
    last_report_at = case when m ? 'report' then now() else last_report_at end
  where id = p_device;
  update public.devices d set pending_command = null
  from (select id, pending_command from public.devices where id = p_device) o
  where d.id = o.id returning o.pending_command into v_cmd;
  if v_cmd is null then return v; end if;
  -- Old commands are plain words; new ones are JSON objects.
  return v || jsonb_build_object('command', case when left(v_cmd, 1) = '{' then v_cmd::jsonb else to_jsonb(v_cmd) end);
end $$;

create function public.admin_device_command(p_device text, p_command jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare c text := p_command->>'cmd';
begin
  perform private.require_admin();
  if c = 'scan' then
    p_command := jsonb_build_object('cmd', 'scan');
  elsif c = 'wifi_add' then
    if coalesce(length(p_command->>'ssid'), 0) not between 1 and 32 then
      raise sqlstate 'PT400' using message = 'Wi-Fi name must be 1 to 32 characters';
    end if;
    if coalesce(p_command->>'pass', '') <> '' and length(p_command->>'pass') not between 8 and 63 then
      raise sqlstate 'PT400' using message = 'Wi-Fi password must be 8 to 63 characters, or empty for an open network';
    end if;
    p_command := jsonb_build_object('cmd', 'wifi_add', 'ssid', p_command->>'ssid', 'pass', coalesce(p_command->>'pass', ''),
                                    'now', coalesce((p_command->>'now')::boolean, false));
  elsif c = 'wifi_forget' then
    p_command := jsonb_build_object('cmd', 'wifi_forget', 'ssid', p_command->>'ssid');
  elsif c = 'update' then
    -- Only firmware stored in this project's own storage, with a checksum the device verifies.
    if p_command->>'url' not like 'https://nikdxqsardermmjkfudv.supabase.co/storage/v1/object/sign/firmware/%' then
      raise sqlstate 'PT400' using message = 'firmware must come from the project storage';
    end if;
    if coalesce(p_command->>'sha256', '') !~ '^[0-9a-f]{64}$' then
      raise sqlstate 'PT400' using message = 'missing firmware checksum';
    end if;
    p_command := jsonb_build_object('cmd', 'update', 'url', p_command->>'url', 'sha256', p_command->>'sha256',
                                    'version', left(coalesce(p_command->>'version', ''), 20));
  else
    raise sqlstate 'PT400' using message = 'unknown command';
  end if;
  update public.devices set pending_command = p_command::text, last_report = null, last_report_at = null where id = p_device;
  if not found then raise sqlstate 'PT400' using message = 'unknown device'; end if;
end $$;

-- The admin page sees each device's Wi-Fi state. A waiting command shows its type, never a password.
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from public.settings s where id = 1),
    'locations', (select coalesce(jsonb_agg(to_jsonb(l) order by l.name), '[]'::jsonb) from public.locations l),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'location_id', d.location_id,
        'last_seen', d.last_seen, 'firmware', d.firmware, 'rssi', d.rssi, 'queued', d.queued,
        'offline', d.offline_alerted,
        'pending_command', case when left(d.pending_command, 1) = '{' then (d.pending_command::jsonb)->>'cmd' else d.pending_command end,
        'wifi_ssid', d.wifi_ssid, 'wifi_saved', d.wifi_saved, 'wifi_scan', d.wifi_scan, 'wifi_scan_at', d.wifi_scan_at,
        'last_report', d.last_report, 'last_report_at', d.last_report_at) order by d.id), '[]'::jsonb) from public.devices d),
    'alerts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id desc), '[]'::jsonb)
               from (select * from public.alerts order by id desc limit 30) a),
    'telegram_configured', exists (select 1 from private.config where key = 'telegram_token'),
    'telegram_subscribers', (select count(*) from public.telegram_subscribers where active));
end $$;

revoke all on function public.ingest(text, text, jsonb, jsonb) from public;
grant execute on function public.ingest(text, text, jsonb, jsonb) to anon, authenticated;
revoke all on function public.admin_device_command(text, jsonb) from public, anon;
grant execute on function public.admin_device_command(text, jsonb) to authenticated;

-- A private storage bucket for firmware files. The binary holds the device key and Wi-Fi details,
-- so it is never public: the admin page gives the device a link that expires after an hour.
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('firmware', 'firmware', false, 4194304) on conflict (id) do nothing;
    execute $p$create policy "admins manage firmware" on storage.objects for all to authenticated
      using (bucket_id = 'firmware' and public.is_admin()) with check (bucket_id = 'firmware' and public.is_admin())$p$;
  end if;
end $$;
