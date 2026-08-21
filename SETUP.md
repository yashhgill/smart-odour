# SETUP — read this one, ignore the older guides

Build `20260820-1957`. Everything below is verified against the real Cloudflare
runtime: 23 of 23 checks passing.

---

## 0. Deploy, and prove which build is live

The recurring problem in this project has been deploying an older folder by
accident. This build answers that directly.

```bash
cd worker
```

```bash
npx wrangler deploy
```

```bash
curl https://odour-router.yashchaal99.workers.dev/api/version
```

You want `"build":"20260820-1957"` and 31 routes. Anything else means you
deployed the wrong folder — check you are inside the newest unzip.

```bash
cd ..
```

```bash
npx wrangler pages deploy dashboard --project-name smart-odour --commit-dirty=true
```

Nine files should upload the first time from a fresh folder.

---

## 1. Create your admin account

Open `https://smart-odour.pages.dev/admin.html`.

It should say **First-Time Setup**, with no invite field. That means the system
knows no accounts exist. Enter your name, email, and a password of **12+
characters**, then Create admin account.

If it says "Create Account" and asks for an invite code, your Worker is a build
behind — go back to step 0.

This route seals itself the moment your account exists. Nobody can bootstrap a
second admin, ever.

---

## 2. Create a student account

1. Sign in to `/admin.html`.
2. **System & Admin → Create invite**. A code appears; it lasts 72 hours and
   works once.
3. Open `https://smart-odour.pages.dev/user.html`, click **Create an account**,
   paste the code.

Roles: `viewer` sees data and can file odour reports; `facility` can also
acknowledge incidents; `admin` can change calibration limits and manage users.
Enforced server-side — hiding a button in the UI is convenience, not security.

---

## 3. Point odour.harnova.my at it

**Pages first.** Cloudflare dashboard → Workers & Pages → smart-odour →
Custom domains → Set up a custom domain → `odour.harnova.my`. Since harnova.my
is already on your account, the DNS record is created for you and the
certificate issues in a few minutes.

**Then fix CORS, or login breaks.** `wrangler.toml` already lists both origins:

```
ALLOWED_ORIGINS = "https://smart-odour.pages.dev,https://odour.harnova.my"
```

If you use a different subdomain, edit that line and redeploy the Worker.
Credentialed CORS cannot use a wildcard, so the origin must match exactly —
scheme included, no trailing slash. A mismatch fails login with an opaque
browser error and nothing useful in the console.

Keep the `pages.dev` entry. Preview deployments still resolve there.

**Leave the Worker on workers.dev.** You could give it a custom domain too, but
the firmware has the hostname compiled in, so changing it means reflashing every
node. Not worth it before the demo.

---

## 4. Telegram alerts

The sending code already exists in `worker/src/api.js`. It needs two secrets.

**Create the bot.** Message **@BotFather** → `/newbot` → give it a name and a
username ending in `bot`. It returns a token like `8123456789:AAF...`. That
token is a password — do not commit it or screenshot it into your report.

**Create the group.** New group → `UTeM Odour Alerts` → add your bot by
`@username` → add the people who should get alerts. Send any message in the
group; the bot cannot see the chat id until one exists.

**Get the chat id.** Open in a browser:

```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

Find `"chat":{"id":-1001234567890`. **Group ids are negative** — keep the minus
sign.

**Store both**, from `worker/`:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

```bash
npx wrangler secret put TELEGRAM_CHAT_ID
```

```bash
npx wrangler deploy
```

**Test it** by posting a reading above the limits. Replace the key:

```bash
BODY='{"node_id":"ESP32_01","zone_id":1,"mq5":900,"mq6":1150,"mq7_1":520,"mq7_2":540,"seq":9001}'
```

```bash
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "YOUR_DEVICE_KEY" -hex | sed 's/.*= //')
```

```bash
curl -X POST https://odour-router.yashchaal99.workers.dev/api/ingest -H "X-Signature: $SIG" -d "$BODY"
```

Index ~76, hazardous, message within seconds. Then clean up:

```bash
npx wrangler d1 execute smart-odour --remote -y --command="delete from readings where seq = 9001"
```

Alerts are capped at one per zone per 30 minutes. The node reports every 8
seconds, so without that cap a sustained spike sends ~450 messages an hour and
everyone mutes the group — which is the same as having no alerting.

---

## 4b. The compute service on Render

Two things cannot run on Workers: **scikit-learn** and **ReportLab** both need
CPython with native extensions. That is the entire reason this service exists —
not a preference for Render, a hard runtime constraint you can state plainly.

If it is down, forecasts go stale and PDF export errors. Readings, alerts, auth
and both dashboards are unaffected. The sidecar is an enhancement, never a
dependency.

### Apply the migration

```bash
cd worker
```

```bash
npx wrangler d1 execute smart-odour --remote -y --file=../d1/migration_003.sql
```

### Generate the shared token

```bash
openssl rand -hex 32
```

Keep it. Both sides need the identical value.

```bash
npx wrangler secret put SERVICE_TOKEN
```

### Deploy to Render

Push the repo to GitHub first, then in the Render dashboard: **New → Blueprint**,
point it at your repo. It reads `api/render.yaml` and creates `odour-compute`
in Singapore on the free plan.

Set `SERVICE_TOKEN` in the Render dashboard to the same value you just gave
wrangler. `render.yaml` marks it `sync: false` precisely so it is never
committed.

Once Render prints your service URL, put it in `worker/wrangler.toml`:

```
COMPUTE_BASE = "https://odour-compute.onrender.com"
```

```bash
npx wrangler deploy
```

### Verify

```bash
curl https://odour-compute.onrender.com/health
```

First call after idle takes about 50 seconds — free instances sleep. The
Worker's cron pokes it every 15 minutes, which keeps it warm during a demo.

Force a fit rather than waiting for the quarter hour:

```bash
curl -X POST https://odour-compute.onrender.com/run-forecast -H "X-Service-Token: YOUR_TOKEN"
```

```bash
curl "https://odour-router.yashchaal99.workers.dev/api/predict?zone_id=4"
```

You want `"available":true` with a model, an R² and four horizons.

### How the model degrades honestly

| Readings available | Model | Why |
|---|---|---|
| 500 or more | `random_forest` | lagged features, chronological hold-out, R² reported |
| 60 to 499 | `linear_trend` | least squares on recent slope |
| under 60 | refused | nothing stored, the UI says why |

Zone 1 will refuse until your hardware has produced 60 readings — about eight
minutes at an 8-second cadence. That refusal is the correct behaviour, and the
AI page states the reason rather than drawing an empty chart.

The hold-out split is **chronological, never random**. Shuffling a time series
leaks the future into training and yields an R² that means nothing. Worth
knowing if you are asked how the fit was validated.

---

## 5. Hardware

### Wiring

| Component | ESP32 pin |
|---|---|
| DHT11 data | GPIO 4 |
| MQ-5 AOUT | GPIO 32 |
| MQ-6 AOUT | GPIO 33 |
| MQ-7 #1 AOUT | GPIO 34 |
| MQ-7 #2 AOUT | GPIO 35 |
| LCD 16x2 I2C SDA | GPIO 21 |
| LCD 16x2 I2C SCL | GPIO 22 |
| All VCC | 5V |
| All GND | GND, common |

Two things about those pins that will save you hours:

**All four MQ sensors are on ADC1.** ADC2 stops working the moment WiFi
connects. If you move a sensor to GPIO 25/26/27 the readings freeze right after
the node joins the network, and it looks like a sensor fault.

**GPIO 34 and 35 are input-only** with no internal pull-ups. Fine for analogue
sensors, but you cannot drive anything from them.

The MQ heaters draw real current. If the LCD flickers or the board resets when
all four are connected, power the sensors from a separate 5V supply with the
grounds tied together — the USB port on a laptop often cannot carry it.

### Firmware

```bash
cd firmware
```

```bash
cp secrets.example.h secrets.h
```

Open `secrets.h`, set `WIFI_SSID`, `WIFI_PASSWORD`, and `DEVICE_KEY`. The Worker
host is already filled in. `secrets.h` is gitignored.

`DEVICE_KEY` must match the Cloudflare secret **exactly**. A mismatch shows up
as `[post] 401` in the serial monitor and nothing else — the node looks healthy
and no data ever arrives.

Arduino IDE → Library Manager, install:

- **DHT sensor library** by Adafruit (accept **Adafruit Unified Sensor**)
- **LiquidCrystal I2C** by Frank de Brabander

Board: ESP32 Dev Module. Upload, then Serial Monitor at **115200**.

```
[wifi] up, ip 192.168.x.x
[sample] idx 31.4  NORMAL
[post] HTTP 200
```

Confirm the server agrees:

```bash
curl https://odour-router.yashchaal99.workers.dev/api/latest
```

Zone 1 should flip from `"status":"offline"` to a live reading.

### Two things that look like faults but are not

**Readings drift downward for 24–48 hours.** MQ heaters need that long to
stabilise. Do not calibrate against day-one numbers, and do not start your data
collection window until after burn-in.

**2.4GHz only.** The ESP32 has no 5GHz radio, and campus WiFi with a captive
portal will not work. Use a phone hotspot.

### Rehearse the offline buffer

Worth doing before the viva — it demonstrates no-data-loss directly:

1. With the node posting, kill the hotspot.
2. LCD shows `Queued 1`, `Queued 2`… and serial shows `[buffer] held`.
3. Bring the hotspot back.
4. Serial shows `[replay] delivered, remaining N` counting to zero.
5. Every reading arrives with its original timestamp and nothing double counts —
   the unique index on `(node_id, seq)` sees to that.

---

## What is verified

Certified against the real runtime, 23 checks:

- bootstrap creates the first admin, then returns 403 forever
- invite issued, used once, refused on reuse and refused when absent
- student registers, signs in, holds the `viewer` role
- student blocked from calibration and the user list; admin allowed
- **a student patching their own profile cannot promote themselves**
- unsigned and wrongly-signed telemetry rejected
- signed telemetry accepted, index computed, replayed reading deduped
- community report filed by a student and reviewed by an admin

## What is still not built

- **the live WebSocket.** The `LiveFeed` Durable Object is deployed and the
  ingest path already broadcasts to it, but neither dashboard subscribes yet.
  Polling every 30 seconds covers it, and at that interval two open tabs sit
  inside the free-tier request budget.

Everything else in both mockups is built.

---

## Deploy order, all in one place

Run from the repo root. Migrations first, always.

```bash
cd worker
```

```bash
npx wrangler d1 execute smart-odour --remote -y --file=../d1/migration_003.sql
```

```bash
npx wrangler secret put SERVICE_TOKEN
```

```bash
npx wrangler deploy
```

```bash
cd ..
```

```bash
npx wrangler pages deploy dashboard --project-name smart-odour --commit-dirty=true
```

Then Render picks up `api/` from the repo on push.

Verify in one line:

```bash
curl https://odour-router.yashchaal99.workers.dev/api/version
```

Build `20260820-1957`, 31 routes. Anything else and you deployed the wrong
folder.

Cloudflare Pages caches aggressively, so hard-reload (Cmd+Shift+R) after a
Pages deploy before concluding it failed. `/api/version` reports the Worker,
not the static files.


---

## Appendix — password hashing, and a bug worth knowing about

Passwords use PBKDF2-HMAC-SHA256 at **100,000 iterations** with a 16-byte
random salt, run inside the `AuthGate` Durable Object.

100,000 is not a tuning choice. Cloudflare's WebCrypto refuses anything higher
and throws `iteration counts above 100000 are not supported`. Raising your plan
does not lift it.

An earlier build set 210,000, following OWASP's 2023 guidance. Every local test
passed, because `wrangler dev` runs Miniflare on Node's WebCrypto, which has no
such cap. It only failed in production, as a 500 on account creation. The code
now clamps to the platform maximum, so a wrong value in `wrangler.toml`
degrades the hashing slightly instead of making login impossible.

If asked why not the recommended 600,000: the runtime will not execute it. What
compensates is a 12-character minimum, lockout after 5 failed attempts per
email in 15 minutes, `login_attempts` as an audit trail, constant-time hash
comparison, and a dummy hash on unknown emails so response timing does not
reveal which addresses are registered.

The wider lesson, which is worth a line in the report: local emulators are not
the runtime. Miniflare accepted a parameter the real platform rejects, and only
an end-to-end test against deployed infrastructure caught it.
