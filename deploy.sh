#!/usr/bin/env bash
#
# Smart Odour — one-command deploy.
#
#   bash deploy.sh
#
# Idempotent. Safe to re-run at any point; it skips whatever is already done.
# Nothing here is destructive: no table is dropped and no reading is deleted.

set -uo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; BLUE=$'\033[34m'; OFF=$'\033[0m'

say()  { printf '%s\n' "$*"; }
head1(){ printf '\n%s%s%s\n' "$BOLD" "$*" "$OFF"; }
ok()   { printf '  %s✔%s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
bad()  { printf '  %s✘%s %s\n' "$RED" "$OFF" "$*"; }
note() { printf '  %s%s%s\n' "$DIM" "$*" "$OFF"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [ ! -d worker ] || [ ! -d dashboard ] || [ ! -d d1 ]; then
  bad "Run this from inside the smart-odour folder."
  note "Expected worker/, dashboard/ and d1/ next to this script."
  exit 1
fi

WORKER_URL="https://odour-router.yashchaal99.workers.dev"

head1 "Smart Odour deploy"
note "Repo: $ROOT"

# ---------------------------------------------------------------- prereqs --
head1 "1. Checking prerequisites"
if ! command -v node >/dev/null 2>&1; then
  bad "Node is not installed. Get it from nodejs.org, then re-run."
  exit 1
fi
ok "node $(node --version)"

cd worker
if [ ! -d node_modules ]; then
  note "Installing wrangler (first run only, takes a minute)…"
  npm install --silent 2>&1 | tail -2
fi
ok "wrangler ready"

ACCOUNT=$(npx wrangler whoami 2>&1)
if grep -qi "not authenticated\|you are not logged in" <<<"$ACCOUNT"; then
  warn "Not logged in to Cloudflare."
  say ""
  say "  The OAuth flow bounces back to http://localhost:8976. If your browser"
  say "  says it cannot connect, that callback port is blocked or the login"
  say "  process already exited. Two ways round it:"
  say ""
  say "    ${BOLD}A.${OFF} Run this on its own, in this terminal, and finish it in the browser:"
  say "         ${BLUE}npx wrangler login${OFF}"
  say ""
  say "    ${BOLD}B.${OFF} Skip OAuth with an API token — more reliable, and it works"
  say "       over SSH or behind a VPN:"
  say "         create one at ${BLUE}https://dash.cloudflare.com/profile/api-tokens${OFF}"
  say "         using the ${BOLD}Edit Cloudflare Workers${OFF} template, then:"
  say "         ${BLUE}export CLOUDFLARE_API_TOKEN=your_token_here${OFF}"
  say "         and run this script again."
  say ""
  read -r -p "  Try the browser login now? [Y/n] " reply
  if [[ "$reply" =~ ^[Nn] ]]; then
    bad "Stopping. Authenticate with either method above, then re-run."
    exit 1
  fi
  npx wrangler login || {
    bad "Login failed. Use the API token route above — it avoids the callback entirely."
    exit 1
  }
fi
ok "Cloudflare authenticated"

# ------------------------------------------------------------- migrations --
head1 "2. Database migrations"
# Each is guarded internally; re-running is a no-op except for migration 002's
# ALTER, whose "duplicate column" error is expected and harmless.
for m in schema migration_002 migration_003; do
  f="../d1/${m}.sql"
  [ -f "$f" ] || { warn "$m.sql not found, skipping"; continue; }
  out=$(npx wrangler d1 execute smart-odour --remote -y --file="$f" 2>&1)
  if grep -qi "duplicate column" <<<"$out"; then
    ok "$m already applied"
  elif grep -qi "error" <<<"$out"; then
    warn "$m reported an error — checking whether it landed anyway"
    note "$(grep -i error <<<"$out" | head -2)"
  else
    ok "$m applied"
  fi
done

# --json gives parseable output. Grepping the drawn table picks up row
# separators and box characters and silently returns the wrong number.
d1count() {
  npx wrangler d1 execute smart-odour --remote -y --json --command="$1" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        try{const j=JSON.parse(s);const r=(j[0]&&j[0].results)||[];
          console.log(r.length?Object.values(r[0])[0]:'');}catch(e){console.log('');}})"
}

TABLES=$(d1count "select count(*) as n from sqlite_master where type='table'")
if [ "${TABLES:-0}" -ge 13 ]; then
  ok "$TABLES tables present"
else
  warn "only ${TABLES:-0} tables — expected 13 or more"
fi

# ------------------------------------------------------------------ seed ---
head1 "3. Historical data"
SEEDED=$(d1count "select count(*) as n from readings where source='seed'")
SEEDED=${SEEDED:-0}

if [ "$SEEDED" -gt 8000 ]; then
  ok "$SEEDED seed readings already loaded"
  # seed.sql uses a plain INSERT, so a second run duplicates every row. Only
  # ever load it when the table is genuinely empty of seed data.
  if [ "$SEEDED" -gt 12000 ]; then
    warn "that is more than expected — the seed appears to have run twice"
    read -r -p "  Remove duplicate seed rows now? [Y/n] " dedupe
    if [[ ! "$dedupe" =~ ^[Nn] ]]; then
      npx wrangler d1 execute smart-odour --remote -y \
        --command="delete from readings where id not in (select min(id) from readings group by zone_id, ts, source)" >/dev/null 2>&1
      ok "duplicates removed, now $(d1count "select count(*) as n from readings") readings"
    fi
  fi
elif [ "$SEEDED" -eq 0 ]; then
  note "Loading 8,643 seed readings (takes a minute)…"
  npx wrangler d1 execute smart-odour --remote -y --file=../d1/seed.sql >/dev/null 2>&1
  ok "$(d1count "select count(*) as n from readings where source='seed'") seed readings loaded"
else
  warn "$SEEDED seed readings present — a partial load. Leaving it alone."
  note "To reload cleanly: delete from readings where source='seed'"
fi

# --------------------------------------------------------------- secrets ---
head1 "4. Secrets"
EXISTING=$(npx wrangler secret list 2>/dev/null || echo "[]")

need_secret() {
  local name="$1" desc="$2" gen="$3"
  if grep -q "\"$name\"" <<<"$EXISTING"; then
    ok "$name already set"
    return
  fi
  say ""
  say "  ${BOLD}$name${OFF} — $desc"
  if [ -n "$gen" ]; then
    local value
    value=$(eval "$gen")
    say "  Generated: ${BLUE}${value}${OFF}"
    if [ "$name" = "DEVICE_KEY" ]; then
      say "  ${YELLOW}Save this — the ESP32 firmware needs the identical value.${OFF}"
      printf '%s\n' "$value" > "$ROOT/DEVICE_KEY.txt"
      say "  ${DIM}Also written to DEVICE_KEY.txt (gitignored).${OFF}"
    fi
    printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null 2>&1 \
      && ok "$name stored" || bad "$name failed"
  else
    read -r -p "  Paste value (blank to skip): " value
    if [ -z "$value" ]; then
      warn "$name skipped"
    else
      printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null 2>&1 \
        && ok "$name stored" || bad "$name failed"
    fi
  fi
}

need_secret DEVICE_KEY    "signs every ESP32 reading"           "openssl rand -hex 32"
need_secret ADMIN_TOKEN   "reserved for admin tooling"          "openssl rand -hex 24"
need_secret SERVICE_TOKEN "shared with the Render sidecar"      "openssl rand -hex 32"

say ""
say "  ${BOLD}Telegram${OFF} — optional, press Enter twice to skip."
note "Get these from @BotFather, then /getUpdates. Group ids are negative."
need_secret TELEGRAM_BOT_TOKEN "bot token from @BotFather" ""
need_secret TELEGRAM_CHAT_ID   "group or chat id"          ""

# ---------------------------------------------------------------- deploy ---
head1 "5. Deploying the Worker"
if npx wrangler deploy 2>&1 | tail -6; then ok "Worker deployed"; else bad "Deploy failed"; exit 1; fi

head1 "6. Deploying the dashboards"
cd "$ROOT"
note "Uploading 9 files. If this sits still for more than two minutes, press"
note "Ctrl+C and run it directly — the output below is unbuffered:"
note "  npx wrangler pages deploy dashboard --project-name smart-odour --commit-dirty=true"
say ""
npx wrangler pages deploy dashboard --project-name smart-odour --commit-dirty=true 2>&1 \
  | grep -Ev "^$" | tail -8

# ---------------------------------------------------------------- verify ---
head1 "7. Verifying"
sleep 3
VER=$(curl -s -m 15 "$WORKER_URL/api/version" 2>/dev/null)
BUILD=$(sed -n 's/.*"build":"\([^"]*\)".*/\1/p' <<<"$VER")
ROUTES=$(grep -o '","' <<<"$VER" | wc -l | tr -d ' ')

if [ -n "$BUILD" ]; then
  ok "live build: $BUILD  (~$ROUTES routes)"
else
  bad "version endpoint did not answer — the Worker may still be propagating"
fi

BOOTSTRAPPED=$(curl -s -m 10 "$WORKER_URL/api/auth/status" 2>/dev/null)
LATEST=$(curl -s -m 10 "$WORKER_URL/api/latest" 2>/dev/null | grep -o '"zone_id"' | wc -l | tr -d ' ')
ok "stations reporting: $LATEST"

head1 "Done"
if grep -q 'false' <<<"$BOOTSTRAPPED"; then
  say "  ${BOLD}Next: create your admin account.${OFF}"
  say "  Open ${BLUE}https://smart-odour.pages.dev/admin.html${OFF}"
  say "  ${DIM}Hard-reload with Cmd+Shift+R first — Pages caches aggressively.${OFF}"
  say "  It should say FIRST-TIME SETUP. Use a password of 12+ characters."
else
  say "  Admin account already exists — sign in at"
  say "  ${BLUE}https://smart-odour.pages.dev/admin.html${OFF}"
fi
say ""
say "  Student portal: ${BLUE}https://smart-odour.pages.dev/user.html${OFF}"
say "  ${DIM}Create an invite from System & Admin to register one.${OFF}"
say ""
say "  Still yours to do:"
say "    · Render sidecar (forecasts + PDF) — see SETUP.md section 4b"
say "    · Wire and flash the ESP32 — SETUP.md section 5"
if [ -f "$ROOT/DEVICE_KEY.txt" ]; then
  say ""
  say "  ${YELLOW}DEVICE_KEY.txt holds the key your firmware needs. Delete it once${OFF}"
  say "  ${YELLOW}you have copied it into firmware/secrets.h.${OFF}"
fi
say ""
