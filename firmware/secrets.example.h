// ---------------------------------------------------------------------------
//  secrets.h  —  fill this in, then never commit it.
//  .gitignore already excludes this file. Keep it that way.
// ---------------------------------------------------------------------------
#pragma once

// Your WiFi. The ESP32 has no 5GHz radio, so this must be a 2.4GHz network.
// UTeM campus WiFi with a captive portal will not work; use a phone hotspot
// or a home router for testing.
#define WIFI_SSID      "YOUR_WIFI_NAME"
#define WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"

// Paste the DEVICE_KEY you generated with `openssl rand -hex 32` and stored
// with `npx wrangler secret put DEVICE_KEY`.
//
// This must match the Cloudflare secret EXACTLY. One wrong character and every
// reading comes back 401 with no other symptom.
#define DEVICE_KEY     "PASTE_YOUR_64_CHAR_HEX_KEY_HERE"

// Your deployed Worker.
#define INGEST_HOST    "odour-router.yashchaal99.workers.dev"
#define INGEST_PATH    "/api/ingest"

// Which zone this board is. Zone 1 is the physical node.
#define NODE_ID        "ESP32_01"
#define ZONE_ID        1
