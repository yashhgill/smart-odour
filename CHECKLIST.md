# Checklist to demo-ready

Verified live on 21 Aug 2026. Build `20260820-2055`.

Ordered so that each item unblocks the next. Work top to bottom — several later
items cannot be tested until earlier ones land.

**Legend** — 🔴 blocks something else · 🟡 needed for the demo · 🟢 polish

---

## 0. Right now, before anything else

- [ ] 🔴 **Revoke the GitHub token.** github.com/settings/personal-access-tokens
      It reaches all 24 repos including MediLink, Masterliqours and Montage, and
      it is in a chat log permanently. Deployment no longer needs it — Cloudflare
      is connected to the repo directly.
- [ ] 🟡 **Delete `DEVICE_KEY.txt`** from your local folder once the key is in
      `firmware/secrets.h`.

---

## 1. Verify the cookie fix actually unblocked the portals

The `SameSite=Strict` bug made every authenticated action fail silently. The fix
is deployed but **not yet confirmed by a human logging in**.

- [ ] 🔴 Sign in at `odour.harnova.my/admin.html` (hard-reload first, Cmd+Shift+R)
- [ ] 🔴 **System & Admin → Create invite** — a code should appear
- [ ] 🔴 **Alerts & Thresholds** → change MQ-6 warning to 1900 → **Apply**
      → should say "Calibration applied", not an error
- [ ] 🔴 Register a user at `odour.harnova.my/user.html` with that invite code
- [ ] 🟡 Sign in as that user, confirm **Alerts & Thresholds is refused** for them

If any of these still fail, stop and tell me — everything downstream assumes
auth works.

---

## 2. Hardware — the long pole

Start this early. The MQ sensors need 24–48 hours of burn-in before their
readings mean anything, so this is the item most likely to run out of calendar.

- [ ] 🔴 Wire the board — pin table in `SETUP.md` §5
      DHT11→4, MQ-5→32, MQ-6→33, MQ-7#1→34, MQ-7#2→35, LCD→21/22
- [ ] 🔴 `cp firmware/secrets.example.h firmware/secrets.h`, fill in WiFi + DEVICE_KEY
- [ ] 🔴 Install **DHT sensor library** (Adafruit) and **LiquidCrystal I2C**
- [ ] 🔴 Upload, open Serial Monitor at 115200, look for `[post] HTTP 200`
- [ ] 🔴 Confirm Zone 1 flips from `offline` to live:
      `curl https://odour-router.yashchaal99.workers.dev/api/latest`
- [ ] 🟡 **Start burn-in now.** Leave it powered 24–48h before trusting readings
      or starting your data-collection window.
- [ ] 🟡 Rehearse the offline-buffer demo: kill WiFi → LCD shows `Queued N` →
      restore → `[replay] delivered, remaining N` counts to zero
- [ ] 🟢 Confirm no brownout with all four MQ heaters running. If the LCD
      flickers or the board resets, use a separate 5V supply, grounds tied.

**Known gotchas:** 2.4GHz only, no captive portal. A DEVICE_KEY mismatch shows
up only as `[post] 401` with the node otherwise looking healthy.

---

## 3. Telegram bot

Nothing to code — the sending logic is already in `worker/src/api.js`. It needs
two secrets. Full walkthrough in `TELEGRAM.md`.

- [ ] 🟡 @BotFather → `/newbot` → get token
- [ ] 🟡 Create group `UTeM Odour Alerts`, add the bot, add your supervisor
- [ ] 🟡 Send one message in the group, then open
      `api.telegram.org/bot<TOKEN>/getUpdates` and copy the chat id
      (**negative** for groups — easy to miss)
- [ ] 🟡 Add both as Worker secrets, then redeploy
- [ ] 🟡 Fire a test alert (curl snippet in `TELEGRAM.md` §5) and confirm the
      message lands
- [ ] 🟢 Reset thresholds afterwards and delete the test reading

**Blocked by:** nothing. Can be done in parallel with hardware.

---

## 4. AI — deploy the forecasting sidecar

Currently `/predict` returns *"The forecasting service has not run yet."* The
model is written and tested; the service is not deployed.

- [ ] 🟡 Render → **New → Blueprint** → point at the repo. It reads
      `api/render.yaml` and creates `odour-compute` in Singapore, free plan.
- [ ] 🟡 Set `SERVICE_TOKEN` in Render to match the Worker secret of the same name
- [ ] 🟡 Put the Render URL into `COMPUTE_BASE` in `worker/wrangler.toml`, push
- [ ] 🟡 Force a run:
      `curl -X POST https://odour-compute.onrender.com/run-forecast -H "X-Service-Token: ..."`
- [ ] 🟡 Confirm `/api/predict?zone_id=4` returns `available:true` with an R²
- [ ] 🟡 Check the **AI Prediction** page renders the curve and feature weights
- [ ] 🟢 Generate an ESG PDF from **Data & Reports** and confirm it downloads

**Do this after hardware is reporting if you can.** Right now the model can only
fit against zones 2–4, which replay data from a generator I wrote — an R² of
0.90 against my own sine wave is not evidence of anything, and "where did the
training data come from" is an obvious question. Once Zone 1 has real readings,
the same pipeline has something genuine to learn from.

---

## 5. Known gaps I would still fix

- [ ] 🟡 **Live WebSocket.** The `LiveFeed` Durable Object is deployed and ingest
      already broadcasts to it, but no dashboard subscribes. Polling every 30s
      covers it. Worth doing because "live" currently means "within 30 seconds".
- [ ] 🟢 **Dedicated Cloudflare API token for Worker builds.** Builds currently
      use your *master-liqours build token*. It works, but revoking that token
      later silently breaks odour deploys.
- [ ] 🟢 Remove the stray `<!-- deployed from GitHub -->` comment I appended to
      `dashboard/index.html` when triggering the first build.
- [ ] 🟢 `AI Prediction` still shows placeholder cards until §4 lands.

---

## 6. Report and presentation

Not code, but these will cost you marks if left.

- [ ] 🔴 **Decide the PPM question.** Her mockups label charts *NH3 Concentration
      (PPM)*. MQ-5/6/7 do not measure ammonia and are not calibrated to any PPM
      scale — they emit raw ADC that drifts with temperature, humidity and sensor
      age. The platform reports a relative 0–100 index instead. If the report says
      PPM, an examiner can dismantle it in one question. Agree the wording with
      her before submission.
- [ ] 🟡 Fix `ABOUT_SYSTEM.docx`: it says MQ135 and MQ4. The hardware is MQ-5,
      MQ-6 and two MQ-7s with a DHT11.
- [ ] 🟡 Rewrite every EC2 / ALB / Auto Scaling / DynamoDB paragraph — none of
      that is in the system now. `ARCHITECTURE.md` §2 has the mapping.
- [ ] 🟢 Two findings worth writing up in methodology, because they are the kind
      of thing markers reward:
      · Cloudflare caps PBKDF2 at 100,000 iterations; 210,000 passed every local
        test because Miniflare uses Node's WebCrypto, and only failed in
        production. Local emulators are not the runtime.
      · `order by ts asc limit N` returned the *oldest* rows — invisible until a
        zone exceeds the limit, then silently wrong for every chart and the model.

---

## Current state, measured

| | |
|---|---|
| Worker build | `20260820-2055` |
| Admin account | exists |
| Stations reporting | 3 of 4 (Zone 1 awaiting hardware) |
| Open incidents | 1 |
| Forecast | not available — sidecar not deployed |
| Domain | `odour.harnova.my` live |
| Auto-deploy | Pages + Workers, both from `main` |

## Suggested order for the week

1. Today — §0 revoke, §1 verify auth, start §2 wiring so burn-in begins
2. While burning in — §3 Telegram, §6 report corrections
3. Once Zone 1 reports — §4 AI sidecar, fit against real data
4. Last — §5 polish, rehearse the failover and offline-buffer demos
