# Smart Odour Monitoring Platform

High-availability environmental odour monitoring for the UTeM campus.
AWS-free rebuild, entirely on **Cloudflare**. RM 0/month.

**Start with `SETUP.md`.** It is the only deployment guide you need.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full AWS → Cloudflare/Render
service mapping and the reliability-demo script.

---

## What's here

| Path | What it is | Status |
|---|---|---|
| `firmware/odour_node.ino` | ESP32 sketch — AWS stripped out, offline ring buffer, non-blocking LCD, health beacon | ✅ done |
| `firmware/secrets_example.h` | Credential template — copy to `secrets.h`, gitignored | ✅ done |
| `db/schema.sql` | Postgres schema: zones, readings, incidents, uptime_samples, alert_log, reports + views | ✅ done |
| `db/seed.sql` | 4 zones + 30 days of realistic history for the 3 virtual nodes | ✅ done |
| `worker/src/index.js` | Cloudflare Worker: `/ingest`, `/api/*` failover router, cron uptime probes, alerting | ✅ done |
| `backend/` | FastAPI: health, readings, incidents, uptime, prediction, ESG PDF | ✅ done |
| `dashboard/` | Static dashboard for Cloudflare Pages — live tiles, dispersion chart, forecast, availability trace, incident console, ESG report | ✅ done |

---

## Quick start

### 1. Neon
Create a project (region: **Singapore / ap-southeast-1**, Postgres 17) → SQL Editor
→ run `db/schema.sql`, then `db/seed.sql`. The last query prints a row count per
zone; zones 2–4 should show ~2,880 readings each.

From **Connection Details**, copy the **pooled** connection string — the host
with `-pooler` in it. The direct string runs out of connections the moment both
Render instances are awake together.

### 2. HiveMQ Cloud
Create a free serverless cluster. Under **Access Management** add two credentials:

| Username | Permission | Used by |
|---|---|---|
| `esp32_node01` | publish to `utem/bita/smartodour/#` | firmware |
| `dashboard` | subscribe to `utem/bita/smartodour/#` | browser over WSS:8884 |

### 3. Render
```bash
# push backend/ to a repo, then in Render: New → Blueprint → point at render.yaml
```
Creates `odour-api-primary` (Singapore) and `odour-api-standby` (Oregon).
Set the same env vars on both; only `INSTANCE_ROLE` differs.

Verify: `curl https://odour-api-primary.onrender.com/health`

### 4. Cloudflare Worker
```bash
cd worker
npm install
wrangler kv namespace create STATE          # paste the id into wrangler.toml
wrangler r2 bucket create smart-odour-raw

wrangler secret put DEVICE_KEY              # openssl rand -hex 32
wrangler secret put DATABASE_URL             # Neon pooled connection string
wrangler secret put ORIGIN_PRIMARY          # https://odour-api-primary.onrender.com
wrangler secret put ORIGIN_STANDBY          # https://odour-api-standby.onrender.com
wrangler secret put RESEND_API_KEY
wrangler secret put ALERT_EMAIL
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID

wrangler deploy
```

Verify the router: `curl https://odour-router.<sub>.workers.dev/router/status`
Verify the proxy:  `curl https://odour-router.<sub>.workers.dev/api/health`
(the `X-Served-By` response header tells you which origin answered)

### 5. Firmware
```bash
cp firmware/secrets_example.h firmware/secrets.h
# fill in WiFi, HiveMQ creds, INGEST_URL, DEVICE_KEY
```
Arduino IDE → install `LiquidCrystal_I2C`, `DHT sensor library`, `PubSubClient`.
Board: ESP32 Dev Module. Flash. Serial monitor at 115200.

You should see `[HTTP] ingest OK (200)` every 8 seconds, and rows appearing in
the `readings` table with `source = 'live'`.

### 6. Dashboard

No build step — it is four static files. Edit `dashboard/config.js` and fill in
`API_BASE` (your Worker URL), the HiveMQ browser credentials, and `ADMIN_TOKEN`
(must match the Render env var of the same name).

```bash
# Cloudflare dashboard → Workers & Pages → Create → Pages → Upload assets
# Drag the dashboard/ folder in. Done.

# Or from the CLI:
cd dashboard && wrangler pages deploy . --project-name smart-odour
```

Test locally first with `python3 -m http.server 8080` inside `dashboard/` —
opening `index.html` directly with `file://` will break the API calls on CORS.

Two things worth knowing about how it behaves:

- **Station 1 updates over MQTT, everything else over HTTPS.** If Render dies,
  the live tile keeps ticking because the browser is subscribed straight to
  HiveMQ. That is deliberate — it is what stops the screen going blank mid-demo.
- **The `X-Served-By` header drives the origin pill** in the top right. It reads
  "primary", "standby", or "edge cache" so the failover is visible on screen
  without opening devtools.

The dispersion chart is drawn as a custom SVG rather than a Leaflet tile map,
because campus WiFi is the least reliable part of any demo and tile maps go
blank without it. It renders from the zone coordinates alone.

---

## Testing the failover before demo day

```bash
# 1. baseline — should say primary
curl -i https://odour-router.<sub>.workers.dev/api/health | grep -i x-served-by

# 2. suspend odour-api-primary in the Render dashboard

# 3. same request — should now say standby, within ~3s
curl -i https://odour-router.<sub>.workers.dev/api/health | grep -i x-served-by

# 4. confirm it was logged
curl https://odour-router.<sub>.workers.dev/api/incidents?open_only=true
```

Rehearse this. It is the single most important two minutes of the presentation.

---

## Wiring reference

| Component | ESP32 pin |
|---|---|
| DHT11 data | GPIO 4 |
| MQ5 analog | GPIO 32 |
| MQ6 analog | GPIO 33 |
| MQ7 #1 analog | GPIO 34 (input only) |
| MQ7 #2 analog | GPIO 35 (input only) |
| LCD SDA | GPIO 21 |
| LCD SCL | GPIO 22 |

All four MQ sensors sit on **ADC1**. Do not move them to GPIO 0/2/4/12–15/25–27
— that is ADC2, which the ESP32 cannot read while WiFi is active. This is the
single most common cause of "my gas sensors read 0 after connecting to WiFi".

The MQ heaters draw ~150 mA each. Four of them plus the LCD backlight and the
fan will brown out a laptop USB port. Use a 5 V 2 A supply into VIN, and give
the sensors 24–48 hours of burn-in before you trust any baseline numbers.

---

## Before anything else: rotate the leaked AWS key

`sketch_aug14a.ino` contains a live AWS IoT device private key and certificate
in plaintext, and that file has been shared. Go to **AWS IoT Core → Security →
Certificates**, deactivate and delete that certificate. Also change the WiFi
password that was hardcoded in it.
