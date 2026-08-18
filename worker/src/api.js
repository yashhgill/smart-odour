/**
 * API routes, backed by D1.
 *
 * This file replaces the entire FastAPI service that previously ran on Render.
 * Every handler returns a plain object; index.js wraps it into a Response with
 * CORS headers, so handlers stay easy to unit test.
 */

/* -------------------------------------------------------------------------- */
/*  Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

export const BANDS = { warning: 40, hazardous: 65 };

/** Composite odour index, 0-100. Mirrored in dashboard/app.js — keep in step. */
export function odourIndex(r) {
  const n = (v, ceiling) => Math.min(1, Math.max(0, (v || 0) / ceiling));
  const score =
    0.20  * n(r.mq5,   1200) +
    0.45  * n(r.mq6,   1200) +
    0.175 * n(r.mq7_1,  900) +
    0.175 * n(r.mq7_2,  900);
  return Math.round(score * 1000) / 10;
}

export function band(index) {
  if (index >= BANDS.hazardous) return 'hazardous';
  if (index >= BANDS.warning) return 'warning';
  return 'normal';
}

const iso = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const hoursAgo = (h) => iso(new Date(Date.now() - h * 3600_000));

/** D1 has no uuid generator, so ids are made here. */
const newId = () => crypto.randomUUID();

const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/* -------------------------------------------------------------------------- */
/*  Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function getZones(env) {
  const { results } = await env.DB.prepare(
    `select id, name, code, latitude, longitude, is_physical, description
       from zones order by id`
  ).all();
  return results.map((z) => ({ ...z, is_physical: !!z.is_physical }));
}

export async function getLatest(env) {
  const { results } = await env.DB.prepare(
    `select * from v_latest_readings order by zone_id`
  ).all();

  // Zones with no readings yet (Zone 1 before the hardware is wired) are absent
  // from the view. Merge them back so the dashboard renders four tiles, not one.
  const zones = await getZones(env);
  const byId = new Map(results.map((r) => [r.zone_id, r]));

  return zones.map((z) => {
    const r = byId.get(z.id);
    if (!r) {
      return {
        zone_id: z.id, zone_name: z.name, code: z.code,
        latitude: z.latitude, longitude: z.longitude,
        is_physical: z.is_physical, ts: null, aqi_score: null,
        status: 'offline', source: null,
      };
    }
    const index = r.aqi_score ?? odourIndex(r);
    return { ...r, is_physical: !!r.is_physical, aqi_score: index, status: band(index) };
  });
}

export async function getReadings(env, url) {
  const zoneId = clampInt(url.searchParams.get('zone_id'), 1, 9999, 1);
  const hours  = clampInt(url.searchParams.get('hours'), 1, 24 * 90, 6);
  const limit  = clampInt(url.searchParams.get('limit'), 1, 5000, 1200);

  const { results } = await env.DB.prepare(
    `select ts, temperature, humidity, mq5, mq6, mq7_1, mq7_2, aqi_score, source
       from readings
      where zone_id = ?1 and ts >= ?2
      order by ts asc
      limit ?3`
  ).bind(zoneId, hoursAgo(hours), limit).all();

  return results;
}

export async function getIncidents(env, url) {
  const openOnly = url.searchParams.get('open_only') !== 'false';
  const limit = clampInt(url.searchParams.get('limit'), 1, 200, 40);

  const sql = openOnly
    ? `select * from incidents where resolved_at is null order by opened_at desc limit ?1`
    : `select * from incidents order by opened_at desc limit ?1`;

  const { results } = await env.DB.prepare(sql).bind(limit).all();
  return results;
}

export async function getUptime(env) {
  const [summary, samples, failovers] = await Promise.all([
    env.DB.prepare(`select * from v_uptime_24h`).all(),
    env.DB.prepare(
      `select ts, origin, healthy, latency_ms from uptime_samples
        where ts >= ?1 order by ts asc limit 400`
    ).bind(hoursAgo(6)).all(),
    env.DB.prepare(
      `select opened_at, message from incidents
        where kind = 'failover' and opened_at >= ?1
        order by opened_at desc limit 10`
    ).bind(hoursAgo(24)).all(),
  ]);

  return {
    summary: summary.results.map((s) => ({ ...s, origin: s.origin })),
    samples: samples.results.map((s) => ({ ...s, healthy: !!s.healthy })),
    recent_failovers: failovers.results,
  };
}

export async function getReports(env, url) {
  const limit = clampInt(url.searchParams.get('limit'), 1, 50, 25);
  const { results } = await env.DB.prepare(
    `select id, title, period_start, period_end, r2_key, generated_at
       from reports order by generated_at desc limit ?1`
  ).bind(limit).all();
  return results;
}

/* -------------------------------------------------------------------------- */
/*  Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Store one reading, evaluate thresholds, and push to connected dashboards.
 * Called by the HTTPS ingest route after the HMAC has been verified.
 */
export async function storeReading(env, payload, ctx) {
  const zoneId = payload.zone_id || 1;
  const reading = {
    zone_id: zoneId,
    node_id: payload.node_id || 'ESP32_01',
    ts: payload.ts || iso(),
    temperature: payload.temperature ?? null,
    humidity: payload.humidity ?? null,
    mq5: payload.mq5 ?? null,
    mq6: payload.mq6 ?? null,
    mq7_1: payload.mq7_1 ?? null,
    mq7_2: payload.mq7_2 ?? null,
    rssi: payload.rssi ?? null,
    seq: payload.seq ?? null,
    source: payload.replayed ? 'replay' : 'live',
  };
  reading.aqi_score = odourIndex(reading);

  // "or ignore" makes a replayed buffer collide harmlessly against the unique
  // index on (node_id, seq) instead of double counting.
  await env.DB.prepare(
    `insert or ignore into readings
       (zone_id, node_id, ts, temperature, humidity, mq5, mq6, mq7_1, mq7_2,
        aqi_score, rssi, seq, source)
     values (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`
  ).bind(
    reading.zone_id, reading.node_id, reading.ts, reading.temperature,
    reading.humidity, reading.mq5, reading.mq6, reading.mq7_1, reading.mq7_2,
    reading.aqi_score, reading.rssi, reading.seq, reading.source
  ).run();

  const status = band(reading.aqi_score);

  // Fan out to dashboards immediately; do not make the node wait for it.
  ctx.waitUntil(broadcast(env, { ...reading, status }));

  // Live readings can raise incidents. Replayed history should not — the event
  // is hours old and alerting on it would page someone about the past.
  if (!payload.replayed && status !== 'normal') {
    ctx.waitUntil(evaluateThreshold(env, reading, status));
  }

  return { ok: true, aqi_score: reading.aqi_score, status };
}

async function broadcast(env, reading) {
  try {
    const id = env.LIVE.idFromName('global');
    await env.LIVE.get(id).fetch('https://live/push', {
      method: 'POST',
      body: JSON.stringify(reading),
    });
  } catch {
    // A dead socket must never break ingestion.
  }
}

/**
 * Open an incident, but only once per zone per cooldown window. Without the
 * cooldown a sustained spike at 8s intervals would open 450 incidents an hour
 * and send just as many emails.
 */
async function evaluateThreshold(env, reading, status) {
  const key = `alert:zone:${reading.zone_id}`;
  if (await env.STATE.get(key)) return;

  const severity = status === 'hazardous' ? 'critical' : 'warning';
  const metric = reading.mq6 >= reading.mq5 ? 'mq6' : 'mq5';
  const id = newId();

  await env.DB.prepare(
    `insert into incidents
       (id, zone_id, kind, severity, metric, value, threshold, message, opened_at)
     values (?1,?2,'threshold',?3,?4,?5,?6,?7,?8)`
  ).bind(
    id, reading.zone_id, severity, metric, reading[metric] ?? null,
    status === 'hazardous' ? BANDS.hazardous : BANDS.warning,
    `Odour index ${reading.aqi_score} at zone ${reading.zone_id} (${severity}).`,
    reading.ts
  ).run();

  // 30 minutes of quiet before the same zone can raise another incident.
  await env.STATE.put(key, id, { expirationTtl: 1800 });
  await sendAlert(env, id, reading, severity);
}

async function sendAlert(env, incidentId, reading, severity) {
  const subject = `[${severity.toUpperCase()}] Odour index ${reading.aqi_score} — zone ${reading.zone_id}`;
  const body = `Zone ${reading.zone_id} recorded an odour index of ${reading.aqi_score} at ${reading.ts}.
MQ5 ${reading.mq5} · MQ6 ${reading.mq6} · CO-A ${reading.mq7_1} · CO-B ${reading.mq7_2}
Temperature ${reading.temperature}C, humidity ${reading.humidity}%.`;

  const log = async (channel, target, ok, detail) =>
    env.DB.prepare(
      `insert into alert_log (incident_id, channel, target, ok, detail)
       values (?1,?2,?3,?4,?5)`
    ).bind(incidentId, channel, target || '', ok ? 1 : 0, detail || null).run();

  if (env.RESEND_API_KEY && env.ALERT_EMAIL) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Odour Monitor <alerts@resend.dev>',
          to: [env.ALERT_EMAIL],
          subject,
          text: body,
        }),
      });
      await log('email', env.ALERT_EMAIL, res.ok, res.ok ? null : `HTTP ${res.status}`);
    } catch (err) {
      await log('email', env.ALERT_EMAIL, false, err.message);
    }
  }

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: `${subject}\n\n${body}`,
          }),
        }
      );
      await log('telegram', env.TELEGRAM_CHAT_ID, res.ok, res.ok ? null : `HTTP ${res.status}`);
    } catch (err) {
      await log('telegram', env.TELEGRAM_CHAT_ID, false, err.message);
    }
  }
}

export async function ackIncident(env, id, verb) {
  const now = iso();
  const sql = verb === 'acknowledge'
    ? `update incidents set acknowledged_at = ?1, acknowledged_by = 'dashboard'
        where id = ?2 and acknowledged_at is null`
    : `update incidents set resolved_at = ?1 where id = ?2 and resolved_at is null`;

  await env.DB.prepare(sql).bind(now, id).run();
  const { results } = await env.DB.prepare(
    `select * from incidents where id = ?1`
  ).bind(id).all();
  return results[0] || null;
}

/* -------------------------------------------------------------------------- */
/*  Cron: health sampling and offline detection                                */
/* -------------------------------------------------------------------------- */

export async function runCron(env) {
  const started = Date.now();
  let healthy = true;
  try {
    await env.DB.prepare('select 1').first();
  } catch {
    healthy = false;
  }

  await env.DB.prepare(
    `insert into uptime_samples (origin, healthy, latency_ms, status_code)
     values ('d1', ?1, ?2, ?3)`
  ).bind(healthy ? 1 : 0, Date.now() - started, healthy ? 200 : 503).run();

  await detectOfflineNodes(env);
}

/**
 * The physical node publishes every 8s. If nothing has arrived for 10 minutes
 * it is genuinely offline, not merely late, so raise one incident and stay
 * quiet until it returns.
 */
async function detectOfflineNodes(env) {
  const { results } = await env.DB.prepare(
    `select z.id, z.name, max(r.ts) as last_ts
       from zones z left join readings r on r.zone_id = z.id and r.source != 'seed'
      where z.is_physical = 1
      group by z.id`
  ).all();

  for (const z of results) {
    const key = `offline:zone:${z.id}`;
    const stale = !z.last_ts || z.last_ts < hoursAgo(1 / 6);

    if (stale && !(await env.STATE.get(key))) {
      await env.DB.prepare(
        `insert into incidents (id, zone_id, kind, severity, message, opened_at)
         values (?1, ?2, 'node_offline', 'warning', ?3, ?4)`
      ).bind(
        newId(), z.id,
        `No telemetry from ${z.name} for over 10 minutes.`,
        iso()
      ).run();
      await env.STATE.put(key, '1', { expirationTtl: 3600 });
    } else if (!stale) {
      await env.STATE.delete(key);
    }
  }
}
