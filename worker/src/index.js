/**
 * Worker entrypoint.
 *
 * Everything the platform serves goes through here: the public API, the
 * authenticated admin API, HTTPS telemetry ingest from the ESP32, the live
 * WebSocket fan-out, and the cron probe.
 */

import { DurableObject } from 'cloudflare:workers';
import * as api from './api.js';
import * as auth from './auth.js';
import * as telegram from './telegram.js';
import * as forecast from './forecast.js';

/** Bumped on every packaged release. GET /api/version to see what is live. */
const BUILD = '20260821-1518';

/** Every route this build serves, so a missing feature is obvious at a glance. */
const ROUTES = [
  'GET /health', 'GET /version', 'GET /zones', 'GET /latest', 'GET /readings',
  'GET /uptime', 'GET /incidents', 'GET /reports', 'GET /thresholds',
  'PUT /thresholds', 'GET /users', 'GET /invites', 'GET /profile',
  'PATCH /profile', 'POST /odour-reports', 'GET /odour-reports',
  'PATCH /incidents/:id/acknowledge', 'PATCH /incidents/:id/resolve',
  'POST /ingest', 'GET /live', 'GET /predict', 'POST /predictions',
  'POST /model-runs', 'POST /reports/esg',
  'POST /telegram/webhook', 'GET /telegram/subscribers',
  'GET /auth/status', 'POST /auth/bootstrap', 'POST /auth/login',
  'POST /auth/logout', 'POST /auth/register', 'POST /auth/invite', 'GET /auth/me',
];

/* -------------------------------------------------------------------------- */
/*  Response helpers                                                           */
/* -------------------------------------------------------------------------- */

// The dashboard is served from Pages on a different origin and sends the
// session cookie, so the allowed origin must be named explicitly — browsers
// reject "*" whenever credentials are included.
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] || ''),
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Token,X-Signature,X-Node-Id',
    'Vary': 'Origin',
  };
}

function json(body, request, env, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
      ...extra,
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Ingest authentication                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The node signs the raw body with a shared secret. This proves a reading came
 * from our hardware rather than from anyone who found the URL, without putting
 * a bearer token in the firmware that leaks the moment someone dumps the flash.
 */
async function verifySignature(env, rawBody, signature) {
  if (!env.DEVICE_KEY || !signature) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.DEVICE_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                     */
/* -------------------------------------------------------------------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '') || '/';
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      /* ---------------- live WebSocket ---------------- */
      if (path === '/live') {
        return env.LIVE.get(env.LIVE.idFromName('global')).fetch(request);
      }

      if (path === '/auth/status' && method === 'GET') {
        return json(await api.authStatus(env), request, env);
      }

      /* ---------------- auth, delegated to the Durable Object -------------- */
      if (path.startsWith('/auth/')) {
        const stub = env.AUTHGATE.get(env.AUTHGATE.idFromName('global'));
        const res = await stub.fetch(
          new Request(`https://authgate${path}`, {
            method,
            headers: request.headers,
            body: method === 'GET' ? undefined : await request.text(),
          })
        );
        // Re-wrap so CORS headers apply while Set-Cookie survives.
        const out = new Response(res.body, res);
        for (const [k, v] of Object.entries(corsHeaders(request, env))) out.headers.set(k, v);
        return out;
      }

      /* ---------------- telegram ---------------- */
      // Telegram posts updates here. Verified by a shared secret set at
      // setWebhook time; without it anyone finding the URL could forge commands.
      if (path === '/telegram/webhook' && method === 'POST') {
        return telegram.handleWebhook(env, request);
      }

      if (path === '/telegram/subscribers' && method === 'GET') {
        await auth.requireRole(env, request, ['admin']);
        return json(await telegram.listSubscribers(env), request, env);
      }

      /* ---------------- telemetry ingest ---------------- */
      if (path === '/ingest' && method === 'POST') {
        const raw = await request.text();
        if (!(await verifySignature(env, raw, request.headers.get('X-Signature')))) {
          return json({ error: 'bad signature' }, request, env, 401);
        }

        let payload;
        try { payload = JSON.parse(raw); }
        catch { return json({ error: 'malformed json' }, request, env, 400); }

        // Archive the raw body to R2 before anything can reject it. If the
        // schema changes later, the original bytes are still recoverable.
        ctx.waitUntil(
          env.RAW.put(
            `raw/${new Date().toISOString().slice(0, 10)}/${Date.now()}.json`, raw
          ).catch(() => {})
        );

        const readings = Array.isArray(payload.readings) ? payload.readings : [payload];
        const results = [];
        for (const r of readings) {
          results.push(await api.storeReading(env, { ...r, replayed: payload.replayed }, ctx));
        }
        return json({ ok: true, accepted: results.length, results }, request, env);
      }

      /* ---------------- public reads ---------------- */
      if (path === '/health') {
        return json({ ok: true, ts: new Date().toISOString() }, request, env);
      }

      // Answers "is the code I just deployed actually running?" without
      // guessing from upload sizes. BUILD changes with every packaged release.
      if (path === '/version') {
        return json({
          build: BUILD,
          routes: ROUTES,
          bootstrapped_check: '/api/auth/status',
        }, request, env);
      }
      if (path === '/zones')    return json(await api.getZones(env), request, env);
      if (path === '/latest')   return json(await api.getLatest(env), request, env);
      if (path === '/readings') return json(await api.getReadings(env, url), request, env);
      if (path === '/uptime')   return json(await api.getUptime(env), request, env);
      if (path === '/incidents' && method === 'GET') {
        return json(await api.getIncidents(env, url), request, env);
      }
      if (path === '/reports' && method === 'GET') {
        return json(await api.getReports(env, url), request, env);
      }

      if (path === '/thresholds' && method === 'GET') {
        return json(await api.getThresholds(env), request, env);
      }

      /* ---------------- authenticated actions ---------------- */
      if (path === '/thresholds' && method === 'PUT') {
        await auth.requireRole(env, request, ['admin']);
        const out = await api.setThresholds(env, await request.json());
        return out.error
          ? json(out, request, env, 400)
          : json(out, request, env);
      }

      if (path === '/odour-reports' && method === 'POST') {
        // Signing in is required, so a report is attributable. An anonymous
        // endpoint here would be an open spam target.
        const user = await auth.requireRole(env, request, null);
        const out = await api.createOdourReport(env, user, await request.json());
        return out.error ? json(out, request, env, 400) : json(out, request, env, 201);
      }

      if (path === '/odour-reports' && method === 'GET') {
        await auth.requireRole(env, request, ['admin', 'facility']);
        return json(await api.listOdourReports(env, url), request, env);
      }

      if (path === '/profile' && method === 'GET') {
        const user = await auth.requireRole(env, request, null);
        return json(await api.getProfile(env, user), request, env);
      }

      if (path === '/profile' && method === 'PATCH') {
        const user = await auth.requireRole(env, request, null);
        return json(await api.updateProfile(env, user, await request.json()), request, env);
      }

      /* ---------------- forecasts ---------------- */
      if (path === '/predict' && method === 'GET') {
        const zoneId = parseInt(url.searchParams.get('zone_id'), 10) || 1;
        const result = await forecast.predictZone(env, zoneId);
        return json(result, request, env);
      }

      // Written only by the Render sidecar, authenticated with a shared token
      // rather than a user session: there is no human in this loop.
      if (path === '/predictions' && method === 'POST') {
        if (!api.serviceTokenValid(env, request)) {
          return json({ error: 'invalid service token' }, request, env, 401);
        }
        const out = await api.storePredictions(env, await request.json());
        return out.error ? json(out, request, env, 400) : json(out, request, env, 201);
      }

      if (path === '/model-runs' && method === 'POST') {
        if (!api.serviceTokenValid(env, request)) {
          return json({ error: 'invalid service token' }, request, env, 401);
        }
        return json(await api.recordModelRun(env, await request.json()), request, env, 201);
      }

      /* ---------------- ESG report ---------------- */
      // Generated on the sidecar (ReportLab is Python), streamed back through
      // here so the browser only ever talks to one origin, and archived to R2.
      if (path === '/reports/esg' && method === 'POST') {
        await auth.requireRole(env, request, ['admin', 'facility']);
        if (!env.COMPUTE_BASE) {
          return json({ error: 'COMPUTE_BASE is not configured' }, request, env, 503);
        }

        const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 30));
        let upstream;
        try {
          upstream = await fetch(`${env.COMPUTE_BASE}/esg-report?days=${days}`, {
            method: 'POST',
            headers: { 'X-Service-Token': env.SERVICE_TOKEN || '' },
          });
        } catch (err) {
          // Render's free tier sleeps; the first call after idle can time out.
          return json({
            error: 'The reporting service did not respond. It may be waking up — try again in about a minute.',
            detail: String(err && err.message),
          }, request, env, 504);
        }

        if (!upstream.ok) {
          return json({ error: `reporting service returned ${upstream.status}` },
                      request, env, 502);
        }

        const pdf = await upstream.arrayBuffer();
        const key = `reports/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.pdf`;

        ctx.waitUntil((async () => {
          try {
            await env.RAW.put(key, pdf, { httpMetadata: { contentType: 'application/pdf' } });
            await env.DB.prepare(
              `insert into reports (id, title, period_start, period_end, r2_key, generated_by)
               values (?1,?2,?3,?4,?5,?6)`
            ).bind(
              crypto.randomUUID(),
              `ESG Odour Report — ${days} days`,
              new Date(Date.now() - days * 86400000).toISOString(),
              new Date().toISOString(),
              key, 'dashboard'
            ).run();
          } catch { /* archiving must not fail the download */ }
        })());

        return new Response(pdf, {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="ESG_Odour_Report_${days}d.pdf"`,
            ...corsHeaders(request, env),
          },
        });
      }

      if (path === '/users' && method === 'GET') {
        await auth.requireRole(env, request, ['admin']);
        return json(await api.listUsers(env), request, env);
      }

      if (path === '/invites' && method === 'GET') {
        await auth.requireRole(env, request, ['admin']);
        return json(await api.listInvites(env), request, env);
      }

      const ack = path.match(/^\/incidents\/([\w-]+)\/(acknowledge|resolve)$/);
      if (ack && method === 'PATCH') {
        await auth.requireRole(env, request, ['admin', 'facility']);
        const updated = await api.ackIncident(env, ack[1], ack[2]);
        return updated
          ? json(updated, request, env)
          : json({ error: 'incident not found' }, request, env, 404);
      }

      return json({ error: 'not found', path }, request, env, 404);

    } catch (err) {
      // requireRole throws {status, body}; anything else is a genuine fault.
      if (err && err.status) return json(err.body, request, env, err.status);
      return json(
        { error: 'internal error', detail: String(err && err.message) },
        request, env, 500
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(api.runCron(env));

    // The cron fires every minute for health sampling. Forecasting is far more
    // expensive and the data barely moves in 60 seconds, so it runs on the
    // quarter hour. This also keeps Render's free instance warm, which is what
    // stops a demo hitting a 50-second cold start.
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (minute % 15 === 0 && env.COMPUTE_BASE) {
      ctx.waitUntil(
        fetch(`${env.COMPUTE_BASE}/run-forecast`, {
          method: 'POST',
          headers: { 'X-Service-Token': env.SERVICE_TOKEN || '' },
        }).catch(() => { /* sidecar down: forecasts go stale, nothing breaks */ })
      );
    }
  },
};

/* -------------------------------------------------------------------------- */
/*  Durable Object: live fan-out                                               */
/* -------------------------------------------------------------------------- */

export class LiveFeed extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/push') {
      const body = await request.text();
      // getWebSockets() survives hibernation, so the socket list never has to
      // be kept in memory between messages.
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(body); } catch { /* dropped socket */ }
      }
      return new Response(null, { status: 204 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    // Hibernation means idle dashboards cost no duration billing.
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    if (message === 'ping') ws.send('pong');
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* already closed */ }
  }
}

/* -------------------------------------------------------------------------- */
/*  Durable Object: auth                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Exists purely for the CPU budget. A Worker request on the free plan is
 * capped at 10ms of CPU; PBKDF2 at 210,000 iterations needs roughly 95ms. A
 * Durable Object request gets 30 seconds, so hashing lives here and the rest
 * of the app keeps the Worker's fast path.
 */
export class AuthGate extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const route = url.pathname.replace('/auth/', '');
    const env = this.env;

    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch { body = {}; }
    }

    let out;
    switch (`${request.method} ${route}`) {
      case 'POST bootstrap': out = await auth.bootstrap(env, body); break;
      case 'POST login':     out = await auth.login(env, request, body); break;
      case 'POST logout':    out = await auth.logout(env, request); break;
      case 'POST register':  out = await auth.register(env, body); break;
      case 'GET me':         out = await auth.me(env, request); break;
      case 'POST invite':
        try {
          out = await auth.createInvite(env, request, body);
        } catch (err) {
          out = err && err.status ? err : { status: 500, body: { error: 'invite failed' } };
        }
        break;
      default:
        out = { status: 404, body: { error: 'unknown auth route', route } };
    }

    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { 'Content-Type': 'application/json', ...(out.headers || {}) },
    });
  }
}

