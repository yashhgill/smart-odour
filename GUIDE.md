# Deployment guide — everything free tier

Run these on your MacBook, in order. Every command assumes you are inside the
unzipped `smart-odour/` folder unless it says otherwise.

Total cost: RM 0. No card, no paid plan.

---

## 0. Before you start

```bash
node --version      # need 18 or newer
```

Nothing else to install globally — `npx` fetches wrangler.

**Revoke the GitHub token you pasted into chat**: github.com/settings/tokens.
Do it now, not later.

---

## 1. File layout

Unzip and you should have exactly this. Nothing needs moving.

```
smart-odour/
├── d1/
│   ├── schema.sql          ← database structure (12 tables/views)
│   └── seed.sql            ← 8,643 rows of history, 718KB
├── worker/
│   ├── src/
│   │   ├── index.js        ← router + LiveFeed + AuthGate Durable Objects
│   │   ├── api.js          ← all data routes, ported from FastAPI
│   │   └── auth.js         ← PBKDF2, sessions, invites, lockout
│   ├── wrangler.toml       ← bindings; account_id and KV id already filled in
│   └── package.json
├── dashboard/              ← static site for Pages
├── firmware/               ← ESP32 sketch
├── GUIDE.md                ← this file
└── ARCHITECTURE.md
```

---

## 2. Push to GitHub (optional but do it)

Nothing deploys from GitHub anymore — this is purely version control, so if it
fights you, skip it and come back later.

```bash
git init
git add -A
git commit -m "Smart odour monitoring platform"
```

Create an empty **private** repo at github.com/new called `smart-odour`, then:

```bash
git remote add origin https://github.com/yashhgill/smart-odour.git
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `secrets.h` and `.env`, so nothing sensitive goes up.

---

## 3. Log in to Cloudflare

```bash
cd worker
npm install
npx wrangler login
```

A browser opens. Click **Allow**. This is the step I could not do for you.

---

## 4. Create the database

```bash
npx wrangler d1 create smart-odour
```

It prints something like:

```
database_id = "a1b2c3d4-...."
```

Open `worker/wrangler.toml`, find `REPLACE_AFTER_WRANGLER_D1_CREATE`, and paste
that id in its place. The id is not a secret — it is safe to commit.

---

## 5. Load schema and data

From inside `worker/`:

```bash
npx wrangler d1 execute smart-odour --remote -y --file=../d1/schema.sql
npx wrangler d1 execute smart-odour --remote -y --file=../d1/seed.sql
```

The seed takes a minute or two. Verify:

```bash
npx wrangler d1 execute smart-odour --remote -y \
  --command="select z.code, count(r.id) as readings from zones z left join readings r on r.zone_id=z.id group by z.id order by z.id"
```

Expected: Z1-LEKIU **0**, and Z2/Z3/Z4 **2881** each. Zero for Z1 is correct —
that is the physical node, and it fills once the ESP32 is running.

---

## 6. Set the secrets

Three values, all typed by you. Generate the first two:

```bash
openssl rand -hex 32     # this is DEVICE_KEY  — copy it, you need it again in step 9
openssl rand -hex 24     # this is ADMIN_TOKEN
```

Then:

```bash
npx wrangler secret put DEVICE_KEY      # paste the 64-char hex
npx wrangler secret put ADMIN_TOKEN     # paste the 48-char hex
```

Optional, only if you want alert emails — sign up free at resend.com:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ALERT_EMAIL     # your email address
```

Without those two, alerts still get written to the database and shown in the
incident console; they just do not leave the building.

---

## 7. Deploy the Worker

```bash
npx wrangler deploy
```

It prints your Worker URL, something like
`https://odour-router.<your-subdomain>.workers.dev`. **Write it down** — steps 8
and 9 both need it.

Check it works:

```bash
curl https://odour-router.<your-subdomain>.workers.dev/api/latest
```

You should get four zones back as JSON.

---

## 8. Deploy the dashboard

Edit `dashboard/config.js` and set `API_BASE` to your Worker URL plus `/api`.
Then, from the repo root:

```bash
npx wrangler pages deploy dashboard --project-name smart-odour
```

It prints a `*.pages.dev` URL. Now go back and make CORS match it:

Open `worker/wrangler.toml`, set `ALLOWED_ORIGINS` to that exact URL, then:

```bash
cd worker && npx wrangler deploy
```

This matters — credentialed CORS cannot use a wildcard, so if the origin does
not match exactly, login will fail with an opaque browser error.

---

## 9. Create your admin account

One-time only. The bootstrap route disables itself permanently afterwards.

```bash
curl -X POST https://odour-router.<your-subdomain>.workers.dev/api/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com","password":"a-long-password-here","full_name":"Yashpreet"}'
```

Password must be at least 12 characters. Expect `201` and your user back.
Run it a second time and you should get `403` — that is the door closing.

---

## 10. Flash the ESP32

**This part is not ready yet.** The current sketch still publishes over MQTT,
which we dropped. I owe you the HTTPS version — it needs your Worker URL and
the `DEVICE_KEY` from step 6 written into `firmware/secrets.h`.

Do steps 1–9 first and tell me your Worker URL. I will hand you a sketch you can
open in Arduino IDE and upload with no edits beyond WiFi name and password.

---

## What is tested and what is not

Verified end to end against the real Cloudflare runtime with a real D1 database
— 19 of 19 checks passing:

- health, zones, latest, readings all return correct shapes
- unsigned and wrongly-signed ingest both rejected with 401
- correctly-signed ingest accepted, odour index computed, zone flips to live
- a replayed reading with a duplicate `seq` is silently deduped, not double counted
- bootstrap creates the first admin, then returns 403 forever after
- passwords under 12 characters rejected
- wrong password and unknown email both 401, and both take the same time
- login sets an HttpOnly session cookie; `/auth/me` returns the admin role
- acknowledging an incident without a session returns 401

Not yet built:

- the firmware HTTPS rewrite (step 10)
- the login/register screens — the API works, there is no UI on it yet
- the dashboard's live WebSocket (it still expects MQTT)
- the ESG PDF export

---

## Free tier headroom

| Limit | Free allowance | Your usage |
|---|---|---|
| Worker requests | 100,000/day | ~12,300/day (node 10,800 + cron 1,440) |
| D1 rows written | 100,000/day | ~10,800/day |
| D1 storage | 5 GB | well under 100 MB/year |
| Durable Object requests | 100,000/day | ~10,800/day |
| R2 storage | 10 GB | raw archive, ~40 MB/month |
| KV reads | 100,000/day | a few hundred |

The tightest one is Worker requests, and the dashboard's polling is what eats
into it. Each open browser tab costs roughly 17,000 requests/day at a 15-second
poll. Two tabs left open all day would push you over. The live WebSocket fixes
this properly — until it lands, do not leave the dashboard open overnight.
