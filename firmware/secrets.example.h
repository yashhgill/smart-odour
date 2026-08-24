// ---------------------------------------------------------------------------
//  secrets.h  —  copy this file to secrets.h, fill it in, never commit it.
//  .gitignore already excludes secrets.h. Keep it that way.
// ---------------------------------------------------------------------------
#pragma once

// The ESP32 has no 5GHz radio, so this must be a 2.4GHz network.
// Campus WiFi with a captive login page will not work — use a phone hotspot.
#define WIFI_SSID      "YOUR_WIFI_NAME"
#define WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"

// Must match the DEVICE_KEY secret stored on the Worker, exactly.
// A mismatch shows up only as "[post] HTTP 401" in the serial monitor —
// the node looks healthy and no data ever arrives.
#define DEVICE_KEY     "PASTE_YOUR_64_CHAR_HEX_KEY_HERE"

#define INGEST_HOST    "odour-router.yashchaal99.workers.dev"
#define INGEST_PATH    "/api/ingest"

// Which station this board is. Zone 1 is the physical node.
#define NODE_ID        "ESP32_01"
#define ZONE_ID        1
