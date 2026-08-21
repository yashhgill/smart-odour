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

  // Take the most RECENT `limit` rows, then return them oldest-first.
  //
  // The obvious `order by ts asc limit N` returns the OLDEST N instead, which
  // is invisible while a zone has fewer rows than the limit and silently wrong
  // the moment it does not. A live node at 8s intervals produces ~10,800 rows a
  // day, so charts would freeze on day-one data and the forecaster would train
  // on history while ignoring the present.
  const { results } = await env.DB.prepare(
    `select ts, temperature, humidity, mq5, mq6, mq7_1, mq7_2, aqi_score, source
       from (
         select ts, temperature, humidity, mq5, mq6, mq7_1, mq7_2, aqi_score, source
           from readings
          where zone_id = ?1 and ts >= ?2
          order by ts desc
          limit ?3
       )
      order by ts asc`
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

    // A node that has never reported is not "offline", it is not built yet.
    // Alerting on it produces one junk incident per cooldown window forever.
    // Only a node that was reporting and then stopped is an incident.
    if (!z.last_ts) continue;

    const stale = z.last_ts < hoursAgo(1 / 6);

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


/* -------------------------------------------------------------------------- */
/*  Calibration thresholds                                                     */
/*                                                                             */
/*  Stored in KV rather than D1: they are read on every ingest and a KV read    */
/*  at the edge is far cheaper than a D1 query. There is exactly one row.       */
/* -------------------------------------------------------------------------- */

export const DEFAULT_THRESHOLDS = {
  mq5:   { warning: 2000, critical: 3000 },
  mq6:   { warning: 2000, critical: 3000 },
  mq7_1: { warning: 1500, critical: 2500 },
  mq7_2: { warning: 1500, critical: 2500 },
};

export async function getThresholds(env) {
  try {
    const raw = await env.STATE.get('thresholds');
    return raw ? { ...DEFAULT_THRESHOLDS, ...JSON.parse(raw) } : DEFAULT_THRESHOLDS;
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

export async function setThresholds(env, body) {
  const out = {};
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    const incoming = body[key] || {};
    const warning  = Number(incoming.warning);
    const critical = Number(incoming.critical);

    // ADC is 12-bit. Reject anything outside the range the hardware can
    // actually produce, and refuse a warning above its own critical, which
    // would silently disable the warning tier.
    if (!Number.isFinite(warning) || !Number.isFinite(critical)) {
      return { error: `${key}: both limits must be numbers` };
    }
    if (warning < 0 || critical > 4095) {
      return { error: `${key}: limits must sit between 0 and 4095` };
    }
    if (warning >= critical) {
      return { error: `${key}: warning limit must be below the critical limit` };
    }
    out[key] = { warning, critical };
  }
  await env.STATE.put('thresholds', JSON.stringify(out));
  return out;
}

/* -------------------------------------------------------------------------- */
/*  User administration                                                        */
/* -------------------------------------------------------------------------- */

export async function listUsers(env) {
  const { results } = await env.DB.prepare(
    `select id, email, full_name, role, created_at from admin_users order by created_at`
  ).all();
  return results;
}

export async function listInvites(env) {
  const { results } = await env.DB.prepare(
    `select code, role, expires_at, used_at from invites order by created_at desc limit 20`
  ).all();
  return results;
}


/* -------------------------------------------------------------------------- */
/*  Community watch                                                            */
/* -------------------------------------------------------------------------- */

const SEVERITIES = ['faint', 'moderate', 'strong', 'overpowering'];

/**
 * A resident reporting a smell the sensors did not catch. Kept in its own
 * table and never merged into `readings`: it is a human observation, not a
 * measurement, and conflating the two would corrupt every chart and the ESG
 * report along with them.
 */
export async function createOdourReport(env, user, body) {
  const severity = SEVERITIES.includes(body.severity) ? body.severity : 'moderate';
  const zoneId = Number(body.zone_id);
  const description = String(body.description || '').slice(0, 500);

  if (!Number.isFinite(zoneId)) {
    return { error: 'a zone must be selected' };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into odour_reports (id, user_id, zone_id, severity, description)
     values (?1, ?2, ?3, ?4, ?5)`
  ).bind(id, user?.id || null, zoneId, severity, description || null).run();

  return { id, zone_id: zoneId, severity, status: 'new' };
}

export async function listOdourReports(env, url) {
  const limit = clampInt(url.searchParams.get('limit'), 1, 100, 30);
  const { results } = await env.DB.prepare(
    `select r.id, r.zone_id, z.name as zone_name, r.severity, r.description,
            r.status, r.created_at, u.full_name as reporter
       from odour_reports r
       left join zones z on z.id = r.zone_id
       left join admin_users u on u.id = r.user_id
      order by r.created_at desc limit ?1`
  ).bind(limit).all();
  return results;
}

/* -------------------------------------------------------------------------- */
/*  Profile                                                                    */
/* -------------------------------------------------------------------------- */

export async function updateProfile(env, user, body) {
  const name = String(body.full_name || '').slice(0, 120);
  const prefs = JSON.stringify({
    dashboard_warnings: body.dashboard_warnings !== false,
    telegram: body.telegram === true,
    email: body.email === true,
  });

  await env.DB.prepare(
    `update admin_users set full_name = ?1, alert_prefs = ?2 where id = ?3`
  ).bind(name || null, prefs, user.id).run();

  return { ok: true, full_name: name, alert_prefs: JSON.parse(prefs) };
}

export async function getProfile(env, user) {
  const row = await env.DB.prepare(
    `select id, email, full_name, role, alert_prefs from admin_users where id = ?1`
  ).bind(user.id).first();
  if (!row) return null;
  let prefs = { dashboard_warnings: true, telegram: false, email: false };
  try { if (row.alert_prefs) prefs = JSON.parse(row.alert_prefs); } catch { /* default */ }
  return { ...row, alert_prefs: prefs };
}


/**
 * Whether the first admin exists yet. Public on purpose: it leaks only that
 * the system is unconfigured, which is already obvious from the fact that
 * nobody can sign in. Letting the UI ask means a fresh deployment can offer
 * "create the first admin" instead of an invite form nobody can satisfy.
 */
export async function authStatus(env) {
  try {
    const row = await env.DB.prepare(`select count(*) as count from admin_users`).first();
    return { bootstrapped: (row?.count || 0) > 0 };
  } catch {
    return { bootstrapped: true };   // fail closed: never invite a bootstrap on error
  }
}


/* -------------------------------------------------------------------------- */
/*  Forecasts                                                                  */
/*                                                                             */
/*  Computed on the Render sidecar, because scikit-learn cannot run here, and   */
/*  stored in D1 so the dashboard reads them at edge speed. A cold or dead      */
/*  sidecar makes forecasts stale; it never blocks a page load or an alert.     */
/* -------------------------------------------------------------------------- */

export function serviceTokenValid(env, request) {
  const supplied = request.headers.get('X-Service-Token');
  if (!env.SERVICE_TOKEN || !supplied) return false;
  if (supplied.length !== env.SERVICE_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) {
    diff |= supplied.charCodeAt(i) ^ env.SERVICE_TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

export async function storePredictions(env, body) {
  const zoneId = Number(body.zone_id);
  const points = Array.isArray(body.points) ? body.points : [];
  const meta = body.meta || {};
  if (!Number.isFinite(zoneId) || !points.length) {
    return { error: 'zone_id and a non-empty points array are required' };
  }

  const generatedAt = iso();
  const features = meta.features ? JSON.stringify(meta.features) : null;

  const statements = points.map((p) => env.DB.prepare(
    `insert into predictions
       (id, zone_id, generated_at, horizon_min, predicted, lower, upper,
        model, r2, n_samples, features)
     values (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
  ).bind(
    crypto.randomUUID(), zoneId, generatedAt,
    Number(p.horizon_min) || 0, Number(p.predicted) || 0,
    p.lower ?? null, p.upper ?? null,
    meta.model || 'unknown', meta.r2 ?? null, meta.n_samples ?? null, features
  ));

  // Keep only the most recent run per zone. Forecasts are superseded every
  // cycle and an unbounded table would eat the free-tier row budget.
  statements.push(env.DB.prepare(
    `delete from predictions where zone_id = ?1 and generated_at < ?2`
  ).bind(zoneId, generatedAt));

  await env.DB.batch(statements);
  return { ok: true, zone_id: zoneId, stored: points.length, model: meta.model };
}

export async function getPrediction(env, url) {
  const zoneId = clampInt(url.searchParams.get('zone_id'), 1, 9999, 1);

  const { results } = await env.DB.prepare(
    `select horizon_min, predicted, lower, upper, model, r2, n_samples,
            features, generated_at
       from predictions where zone_id = ?1
      order by horizon_min asc`
  ).bind(zoneId).all();

  const run = await env.DB.prepare(
    `select started_at, ok, model, zones_fitted, duration_ms, detail
       from model_runs order by started_at desc limit 1`
  ).first();

  if (!results.length) {
    return {
      available: false,
      reason: run
        ? 'No forecast for this zone yet. The model needs at least 60 readings.'
        : 'The forecasting service has not run yet.',
      last_run: run || null,
    };
  }

  let features = null;
  try { features = results[0].features ? JSON.parse(results[0].features) : null; } catch { /* ignore */ }

  return {
    available: true,
    zone_id: zoneId,
    generated_at: results[0].generated_at,
    model: results[0].model,
    r2: results[0].r2,
    n_samples: results[0].n_samples,
    features,
    points: results.map((r) => ({
      horizon_min: r.horizon_min,
      predicted: r.predicted,
      lower: r.lower,
      upper: r.upper,
    })),
    last_run: run || null,
  };
}

export async function recordModelRun(env, body) {
  await env.DB.prepare(
    `insert into model_runs (id, finished_at, ok, model, zones_fitted, duration_ms, detail)
     values (?1,?2,?3,?4,?5,?6,?7)`
  ).bind(
    body.id || crypto.randomUUID(), iso(), body.ok ? 1 : 0,
    body.model || null, body.zones_fitted || 0,
    body.duration_ms || null, body.detail || null
  ).run();

  // Twenty runs of history is plenty to show the AI page a trend.
  await env.DB.prepare(
    `delete from model_runs where id not in
       (select id from model_runs order by started_at desc limit 20)`
  ).run();

  return { ok: true };
}
