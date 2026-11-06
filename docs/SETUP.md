# Setup

## 1. Try the node with only a laptop (no cloud needed)

Install once:

```bash
python3 -m venv tools/.venv
```

```bash
tools/.venv/bin/pip install pyserial
```

```bash
brew install arduino-cli
arduino-cli core install esp32:esp32
arduino-cli lib install "LiquidCrystal I2C" "DHT sensor library"
```

Create settings. WiFi can stay as placeholders for a USB-only test:

```bash
cp firmware/odour_node/secrets.example.h firmware/odour_node/secrets.h
```

Check the board is seen. If not, try a different cable, because many only charge:

```bash
tools/.venv/bin/python tools/usb_node.py --find
```

Upload the firmware. Replace the port with the one shown above:

```bash
arduino-cli compile --upload --fqbn esp32:esp32:esp32 -p /dev/cu.usbserial-0001 firmware/odour_node
```

Watch and record. Readings save to `recordings/` as CSV, even with no WiFi:

```bash
tools/.venv/bin/python tools/usb_node.py
```

The first reading comes after the 5-minute warm-up, then one a minute. Levels mean little until the 24-hour learning finishes.

## 2. Database (Supabase, free)

1. Create a project at supabase.com, region Singapore.
2. In the SQL editor run `supabase/01_schema.sql`, `02_functions.sql`, `03_jobs.sql`, in order.
3. Authentication > Users > Add user. Copy its ID and run `insert into public.app_admins values ('USER-ID');`

## 3. Dashboard

1. Put the project URL and publishable key in `dashboard/config.js`, and set `DEMO: false`.
2. Publish the `dashboard` folder on Cloudflare Pages.
3. Sign in at `/admin.html`, open **Locations and devices**, and click each location's true spot on the map. **Kolej Kediaman Lestari's starting pin is a guess.**

## 4. Connect the node

1. On the admin page add device `NODE-1` and copy the key. It is shown once.
2. Fill in `firmware/odour_node/secrets.h`: 2.4 GHz WiFi, project host, publishable key, device ID and key. Campus WiFi with a login page won't work, so use a hotspot or 4G router.
3. Upload again as above. The LCD should say `WiFi connected`, and the location goes live on the dashboard.

## Wireless updates (OTA)

The first upload must be by USB or a USB-to-serial adapter, because a board can only accept wireless updates once it is running code that supports them. After that:

1. Set `WIFI_SSID`, `WIFI_PASSWORD` and `OTA_PASSWORD` in `secrets.h`, then upload once by USB.
2. Keep the Mac on the same WiFi as the node. Router or hotspot "client isolation" must be off, and campus WiFi usually blocks this.
3. In Arduino IDE choose **Tools > Port > odour-node**, then Upload. Or from a terminal, replacing the address and password:

```bash
arduino-cli upload --fqbn esp32:esp32:esp32 -p 192.168.1.50 --upload-field password=YOUR_OTA_PASSWORD firmware/odour_node
```

## 5. Telegram alerts

Create a bot with @BotFather and a public channel, add the bot as admin, then run this in the SQL editor:

```sql
insert into private.config (key, value) values ('telegram_token', 'TOKEN'), ('telegram_public_chat', '@yourchannel'), ('telegram_admin_chat', 'ADMIN_CHAT_ID')
on conflict (key) do update set value = excluded.value;
```

Put the channel link in `dashboard/config.js` as `TELEGRAM_LINK`.

## Local preview with simulated data

```bash
cd tools && npm install && node dev_server.mjs 8787
```

Open http://localhost:8787 (admin login `admin@example.com` / `demo`).

## Tests

```bash
cd tools && node --test test_db.mjs && python3 test_usb_node.py
```
