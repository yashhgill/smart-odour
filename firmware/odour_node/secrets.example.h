// Copy this file to secrets.h and fill it in. secrets.h is ignored by git.
#pragma once
// ESP32 Wi-Fi is 2.4 GHz only. Networks with a login page (campus Wi-Fi) will
// not work: use a phone hotspot or a small 4G router.
#define WIFI_SSID     "YOUR_WIFI"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
// From Supabase: Project Settings > API. The publishable (anon) key is public by design.
#define SUPABASE_HOST "YOUR-PROJECT.supabase.co"
#define SUPABASE_ANON "YOUR_PUBLISHABLE_KEY"
// Create the device on the admin page. It shows the key once.
#define DEVICE_ID     "NODE-1"
#define DEVICE_KEY    "KEY_FROM_ADMIN_PAGE"
// Password for wireless updates. Wireless updates stay off until you change this.
#define OTA_PASSWORD  "CHANGE_ME"
