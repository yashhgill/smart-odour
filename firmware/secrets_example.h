/* ============================================================================
 *  secrets_example.h  ->  copy to secrets.h and fill in. ADD secrets.h TO .gitignore.
 * ========================================================================== */
#pragma once

// ---------- WiFi ----------
#define WIFI_SSID      "YourSSID"
#define WIFI_PASSWORD  "YourStrongPassword"

// ---------- Stream B: HiveMQ Cloud ----------
// Console -> Access Management -> add credential for the device.
#define HIVEMQ_HOST    "xxxxxxxxxxxx.s1.eu.hivemq.cloud"
#define HIVEMQ_PORT    8883
#define HIVEMQ_USER    "esp32_node01"
#define HIVEMQ_PASS    "device-password-here"

// ---------- Stream A: Cloudflare Worker ingest ----------
#define INGEST_URL     "https://odour-router.<your-subdomain>.workers.dev/ingest"
// Must match the DEVICE_KEY secret set on the Worker (wrangler secret put DEVICE_KEY)
#define DEVICE_KEY     "long-random-string-min-32-chars"

/* ---------------------------------------------------------------------------
 *  TLS
 *
 *  INSECURE_TLS 1  -> skips certificate validation. Fine while you are getting
 *                     the plumbing working; DO NOT submit with this on, and do
 *                     not demo with it on. An examiner asking "is your MQTT
 *                     link authenticated?" will check.
 *
 *  INSECURE_TLS 0  -> validates against ISRG Root X1. Both HiveMQ Cloud and
 *                     Cloudflare chain to Let's Encrypt, so one root covers both.
 *
 *  Get the PEM from https://letsencrypt.org/certs/isrgrootx1.pem and paste it
 *  below between the R"EOF( ... )EOF" delimiters, including the BEGIN/END lines.
 *  Do not retype it by hand — copy the file verbatim, a single wrong character
 *  makes the handshake fail with a rc=-2 that is miserable to debug.
 * ------------------------------------------------------------------------- */
#define INSECURE_TLS 1

static const char ROOT_CA_ISRG_X1[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
PASTE THE CONTENTS OF isrgrootx1.pem HERE
-----END CERTIFICATE-----
)EOF";
