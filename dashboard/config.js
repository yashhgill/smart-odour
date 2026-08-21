// ---------------------------------------------------------------------------
// Edit this file after deploying the Worker. Nothing else needs changing.
// It is loaded as a plain script, so you can edit it directly on Cloudflare
// Pages without rebuilding anything.
// ---------------------------------------------------------------------------
window.CONFIG = {
  // Cloudflare Worker router. It proxies to Render and falls back to the
  // standby origin automatically, so the dashboard never calls Render directly.
  API_BASE: 'https://odour-router.yashchaal99.workers.dev/api',

  // MQTT is gone — the architecture is HTTPS ingest plus a Durable Object
  // WebSocket now. Left disabled here rather than deleted so the fallback
  // polling path stays obvious. The WebSocket client replaces this next.
  MQTT: {
    enabled: false,
    url: 'wss://YOUR-CLUSTER.s1.eu.hivemq.cloud:8884/mqtt',
    username: 'dashboard',
    password: 'CHANGE_ME',
    topic: 'utem/bita/smartodour/#',
  },

  // Odour index bands. Keep these identical to the backend thresholds in
  // worker/src/index.js or the map and the incident list will disagree.
  BANDS: { warning: 40, hazardous: 65 },

  // Must match ADMIN_TOKEN on the Render service. Only gates report generation.
  // Anyone viewing the page can read this, so keep the token low-value and
  // rotate it after the demo.
  // Not used yet: report generation is not wired in this build.
  ADMIN_TOKEN: '',

  POLL_MS: 30000,   // 30s keeps two open tabs inside the free-tier request cap
  TZ_LABEL: 'MYT',
};
