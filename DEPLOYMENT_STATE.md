# Deployment state

Live resources, created 18 Aug 2026. Keep this file updated as you go.

## Done

| Resource | Identifier | Notes |
|---|---|---|
| Neon project | `smart-odour-utem` / `morning-hill-88725919` | AWS Singapore, Postgres 18, branch `production`, database `neondb` |
| Schema | 16 statements applied | zones, readings, incidents, uptime_samples, alert_log, reports, admin_users + 2 views |
| Seed data | 8,643 readings | 2,881 per virtual zone, 19 Jul – 18 Aug 2026, plus 2 historical incidents |
| Cloudflare account | `52c1d557ffffc7359a34d5ddeffc037d` | already in `wrangler.toml` |
| KV namespace | `smart_odour_state` → `3153fe3b5409420c83c07c98b5e678ce` | already in `wrangler.toml` |
| R2 bucket | `smart-odour-raw` | Asia Pacific, standard class |

Zone 1 shows 0 readings on purpose — it is the physical node and fills up the
moment the ESP32 publishes.

## Remaining, in order

1. **Neon connection string.** Neon console → Connect → copy the **pooled** URI
   (host contains `-pooler`). It embeds a password, so paste it straight into
   Render and `wrangler secret` — never into a chat window, a commit, or a
   screenshot.
2. **HiveMQ Cloud.** Create a free serverless cluster. Add two credential sets:
   `esp32_node01` (publish to `utem/bita/smartodour/#`) and `dashboard`
   (subscribe only). Note the cluster URL.
3. **Push to GitHub.** Render deploys from a repo, so this repo has to exist
   first. `.gitignore` already excludes `secrets.h` and `.env`.
4. **Render.** New → Blueprint → point at `backend/render.yaml`. Creates
   `odour-api-primary` (Singapore) and `odour-api-standby` (Oregon). Set
   `DATABASE_URL`, `ADMIN_TOKEN`, and the four R2 variables on both.
5. **R2 API token.** Cloudflare → R2 → Manage API tokens → create one scoped to
   `smart-odour-raw` only. That gives you `R2_ACCESS_KEY_ID` and
   `R2_SECRET_ACCESS_KEY` for Render.
6. **Worker.** `cd worker && npm install && wrangler deploy`, then the
   `wrangler secret put` list in `wrangler.toml`.
7. **Dashboard.** Fill `dashboard/config.js`, then drag the folder into
   Cloudflare Pages.

Steps 1–2 and 5–6 all involve credentials, which is why they are yours rather
than mine.
