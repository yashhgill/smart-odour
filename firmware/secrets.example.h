// ---------------------------------------------------------------------------
//  secrets.h  —  salin fail ini kepada secrets.h, isi nilai, jangan commit.
//  Kunci peribadi TIDAK BOLEH ada dalam fail .ino. Itu sebab sijil AWS
//  dalam kod asal terdedah.
// ---------------------------------------------------------------------------
#pragma once

// ESP32 tiada radio 5GHz, jadi ini mesti rangkaian 2.4GHz.
// WiFi kampus dengan halaman log masuk tidak akan berfungsi — guna hotspot.
#define WIFI_SSID      "NAMA_WIFI_ANDA"
#define WIFI_PASSWORD  "KATA_LALUAN_WIFI"

// Mesti SAMA PERSIS dengan secret DEVICE_KEY pada Cloudflare Worker.
// Kalau tak sama, satu-satunya tanda ialah "[SEND] HTTP 401" di Serial
// Monitor — node nampak sihat tapi tiada data sampai.
#define DEVICE_KEY     "TAMPAL_KUNCI_HEX_64_AKSARA_DI_SINI"

#define INGEST_HOST    "odour-router.yashchaal99.workers.dev"
#define INGEST_PATH    "/api/ingest"

#define NODE_ID        "ESP32_01"
#define NODE_LOCATION  "Kolej Kediaman Lekiu"
#define ZONE_ID        1
