# Telegram bot

Two-way. It pushes alerts, and you can query it — useful mid-demo when someone
asks "what is the campus reading right now" and you answer from your phone.

Nothing to code. The bot lives in `worker/src/telegram.js` and needs two
secrets plus one webhook registration.

---

## 1. Create the bot

Message **@BotFather** in Telegram:

```
/newbot
```

Give it a display name (`UTeM Odour Monitor`) and a username ending in `bot`
(`utem_odour_alert_bot`). BotFather returns a token like `8123456789:AAF...`.

**That token is a password.** Anyone holding it controls the bot completely.
Do not commit it, and do not screenshot it into your report.

While still in BotFather, set the command menu so the bot looks finished:

```
/setcommands
```

Pick your bot, then paste:

```
status - Campus air right now
zones - Every station and its reading
incidents - What is currently open
quiet - Only alert me on critical
all - Alert me on warnings too
stop - Unsubscribe this chat
```

---

## 2. Store the secrets

Generate a webhook secret — any random string. It proves inbound calls really
came from Telegram rather than from anyone who found the URL.

```bash
openssl rand -hex 24
```

From `worker/`:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

---

## 3. Deploy

No migration to run. The subscriber table creates itself the first time the
bot is used — `migration_004.sql` remains the canonical definition, but a
forgotten migration would have surfaced as a confusing error inside a Telegram
chat rather than a clear failure at deploy time.

Push to GitHub and Cloudflare deploys automatically. Nothing to do here.

---

## 4. Register the webhook

One call, once. Replace both placeholders:

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook" \
  -d "url=https://odour-router.yashchaal99.workers.dev/api/telegram/webhook" \
  -d "secret_token=<YOUR_WEBHOOK_SECRET>"
```

Expect `{"ok":true,...}`. Verify:

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo"
```

`pending_update_count` should be 0 and `last_error_message` absent.

---

## 5. Subscribe

Create a group, name it `UTeM Odour Alerts`, add the bot, add whoever should
receive alerts — supervisor included, it demos well.

Then send in the group:

```
/start
```

The bot replies confirming the subscription and lists its commands. That chat
now receives alerts. Every chat that sends `/start` is added, so you never
redeploy to add a recipient.

**Groups need one extra step.** By default Telegram only shows bots messages
that start with `/`. That is fine here, but if the bot seems deaf in a group,
send `/setprivacy` to BotFather and disable privacy mode.

---

## 6. Test without waiting for real gas

Post a reading above the thresholds. Replace the key:

```bash
BODY='{"node_id":"ESP32_01","zone_id":1,"mq5":900,"mq6":1150,"mq7_1":520,"mq7_2":540,"seq":9001}'
```

```bash
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "YOUR_DEVICE_KEY" -hex | sed 's/.*= //')
```

```bash
curl -X POST https://odour-router.yashchaal99.workers.dev/api/ingest -H "X-Signature: $SIG" -d "$BODY"
```

Index lands around 76 — hazardous — and the group gets a message within
seconds. Clean up afterwards:

```bash
npx wrangler d1 execute smart-odour --remote -y --command="delete from readings where seq = 9001"
```

---

## What the alert looks like

```
🔴 CRITICAL — odour index 76.4

Zone 1 · ESP32_01
MQ5 900   MQ6 1150
CO-A 520  CO-B 540
29.4°C   74% RH

2026-08-21T04:12:08Z
Open dashboard
```

---

## Commands

| | |
|---|---|
| `/start` | subscribe this chat |
| `/status` | highest reading on campus right now |
| `/zones` | all four stations with status marks |
| `/incidents` | what is currently open |
| `/quiet` | critical alerts only |
| `/all` | warnings and critical |
| `/stop` | unsubscribe |

---

## Design notes worth knowing for the viva

**Subscribers live in D1, not in a secret.** The earlier version had one chat id
in an environment variable, so adding a recipient meant a redeploy and there was
no way to fan out. Anyone sending `/start` now registers themselves.

**Alerts are capped at one per zone per 30 minutes.** The node reports every 8
seconds; without the cooldown a sustained spike would send roughly 450 messages
an hour and everyone would mute the group, which is the same as having no
alerting at all. The cooldown lives in KV with a TTL, so it expires on its own.

**A chat that returns 403 is deactivated, not retried.** That status means the
bot was blocked or removed from the group — permanent, so retrying forever
would just burn requests.

**The webhook always returns 200, even on a malformed update.** Telegram retries
any non-2xx with the same payload, so one bad message would otherwise loop
indefinitely. Failures are written to `alert_log` instead.

**Replayed readings never alert.** When the node empties its offline buffer the
payload carries `replayed:true` and the threshold check is skipped — those
events are hours old, and paging someone about the past is a bug.

**Chat ids are truncated** in the admin subscriber list. A Telegram chat id
identifies a person's account; there is no reason to display it in full.
