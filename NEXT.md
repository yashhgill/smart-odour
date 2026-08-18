# Where the build stands

## Done this round
- `d1/schema.sql` — SQLite port, validated against real SQLite (10 objects create cleanly)
- `d1/seed.sql` — 8,643 deterministic rows, 2,881 per virtual zone, 30 days, 2 incidents
- `worker/src/api.js` — the whole FastAPI backend ported to D1: zones, latest, readings,
  incidents + ack/resolve, uptime, reports, HTTPS ingest with replay-dedupe,
  threshold incidents with a 30-min cooldown, offline-node detection, email/Telegram alerts
- `worker/wrangler.toml` — D1 + Durable Object + KV + R2 bindings, real account and KV ids

## Still to write
1. `worker/src/index.js` — currently still the Render-proxy version. Needs rewriting to
   route into `api.js` and export the `LiveFeed` Durable Object class. **The Worker will
   not deploy until this is done.**
2. `firmware/odour_node.ino` — drop MQTT, POST to `/api/ingest` with the HMAC header.
   The offline ring buffer and `seq` counter stay exactly as they are.
3. `dashboard/` — swap the MQTT client for a WebSocket to the Durable Object.
4. ESG PDF — port `backend/esg_report.py` to `pdf-lib`.

`backend/` is left in place for now. Delete it once the Worker is proven.

## Your three commands

```bash
cd smart-odour
git init && git add -A && git commit -m "Smart odour monitoring platform"
gh repo create smart-odour --private --source=. --push
```

No `gh`? Create the repo on github.com, then:
```bash
git remote add origin https://github.com/yashhgill/smart-odour.git
git push -u origin main
```

Then:
```bash
cd worker && npm install && npx wrangler login
npx wrangler d1 create smart-odour        # paste the id into wrangler.toml
npx wrangler d1 execute smart-odour --remote --file=../d1/schema.sql
npx wrangler d1 execute smart-odour --remote --file=../d1/seed.sql
```
