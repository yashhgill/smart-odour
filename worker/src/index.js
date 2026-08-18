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
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
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

      /* ---------------- authenticated actions ---------------- */
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
