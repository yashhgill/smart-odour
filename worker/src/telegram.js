/**
 * Telegram integration.
 *
 * Two directions:
 *   outbound — threshold and offline alerts fan out to every active subscriber
 *   inbound  — a webhook handles /start, /status, /zones, /incidents, /stop
 *
 * The bot is stateless. Everything it needs is in D1, so it survives a redeploy
 * and there is no polling loop to keep alive.
 */

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

/**
 * The subscriber table creates itself on first use.
 *
 * migration_004.sql still exists and is the canonical definition, but the bot
 * is the only consumer and a forgotten migration would show up as a confusing
 * runtime error in a Telegram chat rather than a clear failure at deploy time.
 * `create table if not exists` is idempotent and the guard means it runs once
 * per isolate, not once per message.
 */
let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`create table if not exists telegram_subscribers (
      chat_id       text primary key,
      chat_type     text not null default 'private',
      title         text,
      subscribed_at text not null default (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      active        integer not null default 1,
      min_severity  text not null default 'warning'
                    check (min_severity in ('warning','critical')),
      last_error    text,
      last_sent_at  text
    )`),
    env.DB.prepare(`create index if not exists idx_tg_active
      on telegram_subscribers (active) where active = 1`),
  ]);
  schemaReady = true;
}

const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Telegram's MarkdownV2 escapes a painful set of characters. */
function esc(text) {
  return String(text ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c);
}

const BAND = { normal: '🟢', warning: '🟡', hazardous: '🔴', offline: '⚪️' };

/* -------------------------------------------------------------------------- */
/*  Sending                                                                    */
/* -------------------------------------------------------------------------- */

async function send(env, chatId, text, extra = {}) {
  const res = await fetch(API(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      ...extra,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`telegram ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Fan an alert out to every subscriber whose severity floor it clears.
 *
 * A chat that returns 403 has blocked the bot or removed it from the group;
 * that is permanent, so it is deactivated rather than retried forever.
 */
export async function broadcast(env, { severity, text }) {
  if (!env.TELEGRAM_BOT_TOKEN) return { skipped: 'no bot token' };
  await ensureSchema(env);

  const wanted = severity === 'critical' ? ['warning', 'critical'] : ['warning'];
  const { results } = await env.DB.prepare(
    `select chat_id, min_severity from telegram_subscribers
      where active = 1 and min_severity in (${wanted.map(() => '?').join(',')})`
  ).bind(...wanted).all();

  // A chat id in the legacy secret still works, so an existing setup does not
  // break when this migration lands.
  const targets = new Set(results.map((r) => String(r.chat_id)));
  if (env.TELEGRAM_CHAT_ID) targets.add(String(env.TELEGRAM_CHAT_ID));

  let sent = 0, failed = 0;
  for (const chatId of targets) {
    try {
      await send(env, chatId, text);
      sent++;
      await env.DB.prepare(
        `update telegram_subscribers set last_sent_at = ?1, last_error = null
          where chat_id = ?2`
      ).bind(iso(), chatId).run();
    } catch (err) {
      failed++;
      const permanent = /: 40[13]/.test(err.message);
      await env.DB.prepare(
        `update telegram_subscribers set last_error = ?1, active = ?2 where chat_id = ?3`
      ).bind(err.message.slice(0, 200), permanent ? 0 : 1, chatId).run();
    }
  }
  return { sent, failed, recipients: targets.size };
}

/** The message an alert produces. Kept here so format lives in one place. */
export function alertText(env, reading, severity) {
  const mark = severity === 'critical' ? BAND.hazardous : BAND.warning;
  const url = env.DASHBOARD_URL || 'https://odour.harnova.my';

  return [
    `${mark} *${esc(severity.toUpperCase())} — odour index ${esc(reading.aqi_score)}*`,
    ``,
    `Zone ${esc(reading.zone_id)} · ${esc(reading.node_id || 'node')}`,
    `\`MQ5 ${esc(reading.mq5 ?? '—')}   MQ6 ${esc(reading.mq6 ?? '—')}\``,
    `\`CO-A ${esc(reading.mq7_1 ?? '—')}  CO-B ${esc(reading.mq7_2 ?? '—')}\``,
    reading.temperature != null
      ? `\`${esc(reading.temperature)}°C   ${esc(reading.humidity ?? '—')}% RH\``
      : `\`climate sensor did not read\``,
    ``,
    `_${esc(reading.ts || iso())}_`,
    `[Open dashboard](${url})`,
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Commands                                                                   */
/* -------------------------------------------------------------------------- */

const HELP = [
  '*Smart Odour bot*',
  '',
  '`/status` — campus air right now',
  '`/zones` — every station and its reading',
  '`/incidents` — what is currently open',
  '`/quiet` — only alert me on critical',
  '`/all` — alert me on warnings too',
  '`/stop` — unsubscribe this chat',
  '',
  '_Alerts are rate limited to one per zone per 30 minutes\\._',
].join('\n');

async function cmdStatus(env) {
  const { results } = await env.DB.prepare(
    `select zone_name, code, aqi_score, ts from v_latest_readings order by aqi_score desc`
  ).all();

  if (!results.length) return '_No station has reported yet\\._';

  const top = results[0];
  const band = top.aqi_score >= 65 ? 'hazardous' : top.aqi_score >= 40 ? 'warning' : 'normal';
  return [
    `${BAND[band]} *Campus air: ${esc(Number(top.aqi_score).toFixed(1))}*`,
    `Highest at ${esc(top.zone_name)}`,
    ``,
    `_${esc(results.length)} of 4 stations reporting_`,
  ].join('\n');
}

async function cmdZones(env) {
  const { results } = await env.DB.prepare(
    `select z.code, z.name, z.is_physical, r.aqi_score, r.ts
       from zones z left join v_latest_readings r on r.zone_id = z.id
      order by z.id`
  ).all();

  const lines = results.map((z) => {
    if (z.aqi_score == null) return `${BAND.offline} \`${esc(z.code)}\` no data`;
    const band = z.aqi_score >= 65 ? 'hazardous' : z.aqi_score >= 40 ? 'warning' : 'normal';
    const kind = z.is_physical ? 'hardware' : 'replay';
    return `${BAND[band]} \`${esc(z.code)}\` *${esc(Number(z.aqi_score).toFixed(1))}* _${esc(kind)}_`;
  });
  return ['*Stations*', '', ...lines].join('\n');
}

async function cmdIncidents(env) {
  const { results } = await env.DB.prepare(
    `select kind, severity, message, opened_at from incidents
      where resolved_at is null order by opened_at desc limit 8`
  ).all();

  if (!results.length) return '🟢 *No open incidents\\.* All stations within thresholds\\.';

  return ['*Open incidents*', '', ...results.map((i) =>
    `${i.severity === 'critical' ? '🔴' : '🟡'} ${esc(i.message)}\n   _${esc(i.opened_at)}_`
  )].join('\n');
}

async function subscribe(env, chat) {
  await env.DB.prepare(
    `insert into telegram_subscribers (chat_id, chat_type, title, active)
     values (?1, ?2, ?3, 1)
     on conflict(chat_id) do update set active = 1, title = excluded.title`
  ).bind(String(chat.id), chat.type || 'private',
         chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || null).run();
}

async function setSeverity(env, chatId, level) {
  await env.DB.prepare(
    `update telegram_subscribers set min_severity = ?1 where chat_id = ?2`
  ).bind(level, String(chatId)).run();
}

/* -------------------------------------------------------------------------- */
/*  Webhook                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Telegram posts updates here. It sends the secret configured at setWebhook
 * time in X-Telegram-Bot-Api-Secret-Token; without checking it, anyone who
 * finds the URL could forge commands.
 *
 * Always returns 200. A non-2xx makes Telegram retry the same update
 * repeatedly, which turns one malformed message into a loop.
 */
export async function handleWebhook(env, request) {
  const supplied = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!env.TELEGRAM_WEBHOOK_SECRET || supplied !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  let update;
  try { update = await request.json(); } catch { return new Response('ok'); }

  try { await ensureSchema(env); } catch { /* reported below if it matters */ }

  const msg = update.message || update.channel_post;
  if (!msg || !msg.text) return new Response('ok');

  const chat = msg.chat;
  // In groups Telegram appends @botname to commands.
  const cmd = msg.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();

  try {
    let reply;
    switch (cmd) {
      case '/start':
        await subscribe(env, chat);
        reply = ['✅ *Subscribed\\.*', '',
                 'This chat will receive odour alerts for the UTeM campus\\.',
                 '', HELP].join('\n');
        break;
      case '/stop':
        await env.DB.prepare(
          `update telegram_subscribers set active = 0 where chat_id = ?1`
        ).bind(String(chat.id)).run();
        reply = '🔕 Unsubscribed\\. Send `/start` to resume\\.';
        break;
      case '/quiet':
        await setSeverity(env, chat.id, 'critical');
        reply = '🔉 This chat will now only be alerted on *critical* readings\\.';
        break;
      case '/all':
        await setSeverity(env, chat.id, 'warning');
        reply = '🔔 This chat will be alerted on *warning* and *critical* readings\\.';
        break;
      case '/status':    reply = await cmdStatus(env); break;
      case '/zones':     reply = await cmdZones(env); break;
      case '/incidents': reply = await cmdIncidents(env); break;
      case '/help':      reply = HELP; break;
      default:
        return new Response('ok');   // ignore ordinary chatter
    }
    await send(env, chat.id, reply);
  } catch (err) {
    // Swallow and log: a thrown error here would make Telegram retry forever.
    try {
      await env.DB.prepare(
        `insert into alert_log (channel, target, ok, detail) values ('telegram', ?1, 0, ?2)`
      ).bind(String(chat.id), String(err.message).slice(0, 200)).run();
    } catch { /* nothing more we can do */ }
  }

  return new Response('ok');
}

/** Admin-facing: who is currently receiving alerts. */
export async function listSubscribers(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    `select chat_id, chat_type, title, min_severity, active, subscribed_at,
            last_sent_at, last_error
       from telegram_subscribers order by subscribed_at desc`
  ).all();
  // Chat ids identify a person's Telegram account, so they are truncated for
  // display rather than shown in full on a dashboard.
  return results.map((r) => ({
    ...r,
    chat_id: String(r.chat_id).replace(/^(-?\d{3})\d+(\d{2})$/, '$1…$2'),
    active: !!r.active,
  }));
}
