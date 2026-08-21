# Telegram alerts

The Worker already sends to Telegram — the code is in `sendAlert()` in
`worker/src/api.js`. It just needs two secrets. No bot code to write and nothing
to host.

Two options. Read both before picking, because switching later means redoing
step 3.

| | Direct messages | Group |
|---|---|---|
| Who gets alerts | only you | everyone in the group |
| Setup | simpler | one extra step |
| Good for | testing, a single facility manager | the actual use case: staff, supervisor, examiner |

Pick the **group** if you want "notification for all users", which is what you
asked for. A group also demos better — you can add your supervisor to it and
they see alerts arrive live.

---

## 1. Create the bot

In Telegram, search for **@BotFather** and start a chat.

```
/newbot
```

It asks for a display name (`UTeM Odour Monitor`) and then a username, which
must end in `bot` (`utem_odour_alert_bot`).

BotFather replies with a token like `8123456789:AAF...`. **That token is a
password.** Anyone holding it controls the bot. Do not commit it, do not paste
it into chat, do not screenshot it into your report.

---

## 2. Create the group and add the bot

1. Telegram → new group → name it `UTeM Odour Alerts`.
2. Add your bot to it by its `@username`.
3. Add the people who should receive alerts.

Then send one message in the group, anything at all. The bot cannot see the
group's id until there is at least one message.

---

## 3. Get the chat id

Open this in a browser, with your real token:

```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

Find `"chat":{"id":-1001234567890`. **Group ids are negative** — include the
minus sign. A direct-message id is positive.

Nothing there? Send another message in the group and reload. Telegram only
retains recent updates.

---

## 4. Store both secrets

From `worker/`:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

```bash
npx wrangler secret put TELEGRAM_CHAT_ID
```

Then redeploy so the running Worker picks them up:

```bash
npx wrangler deploy
```

---

## 5. Test it without waiting for real gas

Sign in to the admin portal, go to **Alerts & Thresholds**, and drop the MQ-6
warning limit to something the seeded data already exceeds — around `400`.
The next threshold breach fires a message.

To force it immediately, post a reading above the limit using your DEVICE_KEY.
Replace both placeholders:

```bash
BODY='{"node_id":"ESP32_01","zone_id":1,"mq5":900,"mq6":1150,"mq7_1":520,"mq7_2":540,"seq":9001}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "YOUR_DEVICE_KEY" -hex | sed 's/.*= //')
curl -X POST https://odour-router.yashchaal99.workers.dev/api/ingest -H "X-Signature: $SIG" -d "$BODY"
```

That should land an odour index around 76 — hazardous — and push a message to
the group within a second or two.

Afterwards, set your thresholds back to sane values and delete the test reading:

```bash
npx wrangler d1 execute smart-odour --remote -y --command="delete from readings where seq = 9001"
```

---

## What the alert looks like

```
[CRITICAL] Odour index 76.4 — zone 1

Zone 1 recorded an odour index of 76.4 at 2026-08-19T04:12:08Z.
MQ5 900 · MQ6 1150 · CO-A 520 · CO-B 540
Temperature 29.4C, humidity 74%.
```

---

## Things worth knowing before the viva

**Alerts are rate limited to one per zone per 30 minutes.** This is deliberate.
The node reports every 8 seconds, so a sustained spike without the cooldown
would send roughly 450 messages an hour and everyone would mute the group —
which is the same as having no alerting at all. The cooldown lives in KV with a
1800-second TTL, so it expires on its own.

**Every send is logged to the `alert_log` table** whether it succeeded or not,
with the failure reason. If someone asks how you know the alerts actually
delivered, that table is the answer rather than your word.

**Replayed readings never alert.** When the node empties its offline buffer, the
payload carries `replayed:true` and the threshold check is skipped. Those events
are hours old, and paging someone about the past is a bug, not a feature.

**Email is a separate channel.** If you also set `RESEND_API_KEY` and
`ALERT_EMAIL`, both fire independently — one failing does not stop the other.
