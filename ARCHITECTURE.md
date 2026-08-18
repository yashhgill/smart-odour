# Smart Odour Monitoring Platform — Non-AWS Architecture

**Project:** High-Availability Smart Odour Monitoring Platform (UTeM Campus)
**Pillar under evaluation:** Reliability / High Availability
**Cloud stack:** Cloudflare + Render + Neon + HiveMQ Cloud
**Target:** ≥ 99.5% uptime, < 60s failover, zero data loss

---

## 1. Why the stack changed

The original design was AWS-only (IoT Core, EC2, Lambda, DynamoDB, RDS, S3, SNS, ALB, ASG).
That works, but on a Learner Lab it dies when credits expire, the lab session resets, or the
grader opens it three weeks after submission. This rebuild uses services with **permanent free
tiers**, so the system is still live on demo day and still live when the examiner checks it later.

Nothing in the academic story is lost. Every AWS component has a direct functional equivalent,
and two of them (the failover router and the ingest edge) are actually *easier to demo live*
than the AWS versions.

---

## 2. Service mapping

| Original AWS service | Replacement | Notes |
|---|---|---|
| **AWS IoT Core** (MQTT broker, X.509) | **HiveMQ Cloud** (TLS 8883, user/pass) | Managed MQTT broker, free serverless tier, WSS 8884 for the browser. Same MQTT semantics, same topic tree. |
| **EC2** (web/app server) | **Render Web Service** × 2 regions | FastAPI. Two instances = primary + standby. |
| **Application Load Balancer** | **Cloudflare Worker** (`router`) | Health-aware reverse proxy. Fails over primary → standby on timeout or 5xx. This is the live "pull the plug" demo. |
| **Auto Scaling Group** | **Cloudflare Workers runtime** (ingest) + Render instance scaling | The ingest path scales to Cloudflare's edge automatically — no cold start, no idle cost. |
| **AWS Lambda** | **Cloudflare Workers + Cron Triggers** | Threshold evaluation, health probes, uptime sampling, scheduled prediction refresh. |
| **DynamoDB** (raw telemetry) | **Neon Postgres** — `readings` table | Time-series indexed on `(zone_id, ts DESC)`. Handles the same write volume at this scale. |
| **RDS** (relational/admin) | **Neon Postgres** — `users`, `zones`, `incidents` | Same database, separate concerns. Neon gives Multi-AZ-equivalent managed backups. |
| **S3** (raw archive, PDFs, assets) | **Cloudflare R2** | S3-compatible API, zero egress fees. |
| **SNS** (alerting) | **Resend** (email) + **Telegram Bot API** | Telegram gives you an instant, visible ping during the presentation. |
| **VPC** (public/private subnets) | **Cloudflare Zero Trust + Neon RLS + service-key isolation** | The database is never exposed to the browser; only the Worker and Render hold the service key. |
| Static hosting | **Cloudflare Pages** | React dashboard, global CDN. |

---

## 3. Data flow — the dual-stream design

The original document already claims a "dual-stream architecture". This version makes it real,
and the two streams are genuinely independent — which is the whole reliability argument.

```
                         ┌──────────────────────────────────────┐
                         │  ESP32 Node 01 (Kolej Lekiu)         │
                         │  MQ5 · MQ6 · MQ7×2 · DHT11 · LCD     │
                         │  + 64-slot offline ring buffer       │
                         └──────────┬───────────────┬───────────┘
                                    │               │
            STREAM A (durable)      │               │   STREAM B (realtime)
            HTTPS POST + HMAC       │               │   MQTT/TLS 8883
                                    ▼               ▼
                    ┌───────────────────────┐   ┌──────────────────┐
                    │ Cloudflare Worker     │   │ HiveMQ Cloud     │
                    │  /ingest              │   │ broker           │
                    │  • auth + validate    │   └────────┬─────────┘
                    │  • write Postgres     │            │ WSS 8884
                    │  • archive raw → R2   │            │
                    │  • threshold → alert  │            ▼
                    └───────┬───────────────┘   ┌──────────────────┐
                            │                   │ React dashboard  │
                            ▼                   │ (Cloudflare      │
                    ┌───────────────────┐       │  Pages)          │
                    │ Neon Postgres │◄──────┤ live tiles from  │
                    │ readings/incidents│       │ MQTT, history &  │
                    │ zones/uptime      │       │ AI from REST     │
                    └─────────▲─────────┘       └────────┬─────────┘
                              │                          │ /api/*
                    ┌─────────┴─────────┐                ▼
                    │ FastAPI on Render │      ┌────────────────────┐
                    │ PRIMARY (sin)     │◄─────┤ Cloudflare Worker  │
                    ├───────────────────┤      │  router (the ALB)  │
                    │ FastAPI on Render │◄─────┤  health-aware      │
                    │ STANDBY (oregon)  │      │  failover < 60s    │
                    └───────────────────┘      └────────────────────┘
```

**Why two streams matter for the grade:** if HiveMQ goes down, no data is lost — Stream A is
the system of record. If Cloudflare's ingest is unreachable, the node buffers up to 64 readings
in RAM and replays them on reconnect. If Render dies entirely, ingestion and live display keep
working, because neither stream depends on Render. Render only serves analytics and reports.

That is a genuinely fault-tolerant topology with **no single point of failure in the data path**,
which is a stronger claim than the original AWS design (where EC2 sat in the critical path).

---

## 4. How the reliability demo works

This is the part to rehearse. It is the whole pillar.

1. Open the dashboard. The **System Health** panel shows both Render origins green, current
   latency, and rolling uptime % computed from the `uptime_samples` table.
2. In the Render dashboard, **suspend the primary service**.
3. The Cloudflare router's next request to primary times out (2s budget), it retries the
   standby, serves the response, and writes a `failover` row to `incidents`.
4. The health panel flips primary to red, standby to green, and a banner shows
   `FAILOVER COMPLETE — Xs`. The cron probe runs every minute, so worst case is ~60s;
   request-driven failover is typically **under 3 seconds**.
5. Resume the primary. The router health-checks it back into rotation.

Nothing is faked — the router genuinely proxies to whichever origin answers.

---

## 5. Four-zone strategy (unchanged)

- **Zone 1 — Kolej Kediaman Lekiu:** the physical ESP32. Live telemetry.
- **Zones 2, 3, 4:** virtual nodes replayed from seeded historical data in Postgres, generated
  with realistic diurnal patterns. `zones.is_physical` flags the difference so the dashboard
  can label them honestly — do not let the examiner think you claimed four devices.

---

## 6. Cost

| Service | Tier | Cost |
|---|---|---|
| Cloudflare Workers | Free — 100k req/day | RM 0 |
| Cloudflare Pages | Free — unlimited static | RM 0 |
| Cloudflare R2 | Free — 10 GB, no egress | RM 0 |
| Neon | Free — 500 MB Postgres | RM 0 |
| Render Web Service × 2 | Free tier | RM 0 |
| HiveMQ Cloud | Free serverless | RM 0 |
| Resend | Free — 3k emails/month | RM 0 |
| **Total** | | **RM 0/month** |

**Free-tier caveat you must handle:** Render free services sleep after 15 minutes idle.
The Worker cron pings both origins every minute, which keeps them warm. Mention this openly
in the report as a documented mitigation rather than hiding it — examiners respect that more
than a surprise cold start mid-demo.

---

## 7. Repository layout

```
smart-odour/
├── ARCHITECTURE.md          ← this file
├── firmware/
│   └── odour_node.ino       ESP32 sketch, AWS removed, offline buffer, non-blocking LCD
├── worker/
│   ├── src/index.js         ingest + failover router + cron probes
│   └── wrangler.toml
├── backend/
│   ├── main.py              FastAPI app
│   ├── config.py
│   ├── db.py
│   ├── routers/             readings · incidents · predict · reports · health
│   ├── requirements.txt
│   └── render.yaml
└── db/
    ├── schema.sql
    └── seed.sql
```

---

## 8. Deployment order

1. **Neon** — create project, run `db/schema.sql` then `db/seed.sql`. Copy the project URL
   and `service_role` key.
2. **HiveMQ Cloud** — create a free serverless cluster, add a device credential
   (`esp32_node01`) and a read-only browser credential (`dashboard`).
3. **Render** — deploy `backend/` twice from `render.yaml`: `odour-api-primary` (Singapore)
   and `odour-api-standby` (Oregon). Same env vars on both.
4. **Cloudflare Worker** — set secrets, `wrangler deploy`. Note the `*.workers.dev` URL or bind
   a custom route.
5. **Firmware** — fill in WiFi, HiveMQ credentials, Worker ingest URL and device key. Flash.
6. **Dashboard** — deploy to Cloudflare Pages pointing `VITE_API_BASE` at the Worker router.

---

## 9. Security cleanup required before anything else

The original `sketch_aug14a.ino` has the **AWS IoT device private key and certificate pasted in
plaintext**, and that file has been shared around. Even though AWS is being dropped:

- Go to **AWS IoT Core → Security → Certificates**, find the cert, **Deactivate** then **Delete** it.
- The WiFi password is also hardcoded (`12345678`). Change it, and move credentials into a
  `secrets.h` that is gitignored.

Do this first. A leaked private key is a finding an examiner will notice, and it is a real risk
regardless.

---

## 10. Documentation inconsistency to fix before submission

`ABOUT_SYSTEM.docx` states the nodes use **MQ135 and MQ4** sensors. The firmware
and the physical prototype use **MQ5, MQ6, and two MQ7s** with a DHT11. An
examiner reading the report while looking at the board will catch this. Pick the
real set — MQ5 / MQ6 / MQ7×2 / DHT11 — and correct it everywhere in the writeup.

The same document also describes hosting on EC2 with an ALB and Auto Scaling
Group. Every one of those paragraphs needs rewriting against section 2 of this
document before the report goes in.

---

## 11. Why Neon rather than Supabase

Supabase's free tier caps an owner at two active projects, and both slots were
already taken by live work. Neon's free tier allows ten, so the odour platform
gets an isolated database instead of sharing a schema with an unrelated
production system — which is the right call regardless of the quota, because a
student project should never be one bad migration away from a live e-commerce
database.

The trade-off: Supabase ships PostgREST, so the backend could talk to it over
plain HTTP. Neon does not. Two changes followed:

- `backend/db.py` now runs **asyncpg** against the pooled endpoint. It keeps the
  PostgREST-style filter dialect (`zone_id=eq.1`, `order=ts.desc`) and compiles
  it to parameterised SQL, so none of the route handlers changed. Table and
  column names are checked against an allow-list, because identifiers cannot be
  bound as parameters.
- `worker/src/index.js` uses **@neondatabase/serverless**, which reaches Postgres
  over HTTP. Cloudflare Workers cannot open raw TCP sockets, so a normal
  Postgres driver would not run there at all.

Both sides now hold a connection string rather than an API key, which also means
the database is no longer reachable from a browser under any circumstance.
