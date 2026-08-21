/* ===========================================================================
 *  Smart Odour Monitoring — ESP32 edge node
 *
 *  Publishes over HTTPS to a Cloudflare Worker. Each request body is signed
 *  with HMAC-SHA256 using a key shared with the Worker, so a reading cannot be
 *  forged by anyone who merely knows the URL.
 *
 *  HARDWARE
 *    DHT11        data  -> GPIO 4
 *    MQ-5         AOUT  -> GPIO 32
 *    MQ-6         AOUT  -> GPIO 33
 *    MQ-7 (A)     AOUT  -> GPIO 34
 *    MQ-7 (B)     AOUT  -> GPIO 35
 *    LCD 16x2 I2C SDA   -> GPIO 21,  SCL -> GPIO 22,  address 0x27
 *    5V relay IN        -> GPIO 26   (exhaust fan, active LOW by default)
 *
 *    The relay module takes 5V and GND from the board, but drive the FAN from
 *    its own supply through the relay contacts. Running a fan off the ESP32's
 *    regulator will brown it out mid-alert, which is the worst possible moment.
 *
 *    GPIO 34 and 35 are input-only and have no internal pull-ups. That is fine
 *    for analogue sensors but means you cannot drive anything from them.
 *    All four MQ pins are on ADC1 on purpose: ADC2 is unusable while WiFi is
 *    active, which is the classic "readings freeze once it connects" bug.
 *
 *  LIBRARIES (Arduino IDE -> Library Manager)
 *    "DHT sensor library" by Adafruit  (plus "Adafruit Unified Sensor")
 *    "LiquidCrystal I2C" by Frank de Brabander
 *    Board package: esp32 by Espressif
 *
 *  BEFORE UPLOADING
 *    Copy secrets.example.h to secrets.h and fill in all five values.
 * =========================================================================== */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include <time.h>
#include "mbedtls/md.h"

#include "secrets.h"

/* ------------------------------------------------------------------ pins -- */
#define DHT_PIN     4
#define DHT_TYPE    DHT11
#define MQ5_PIN     32
#define MQ6_PIN     33
#define MQ7_1_PIN   34
#define MQ7_2_PIN   35

/* Exhaust relay. GPIO 26 is on ADC2, which is unusable for analogRead while
   WiFi is active — but this is a digital output, so that restriction does not
   apply. All four MQ sensors stay on ADC1 for exactly that reason.

   Most 5V relay boards sold for Arduino are ACTIVE LOW: the coil energises
   when the pin is pulled LOW. Set RELAY_ACTIVE_LOW to 0 if yours is the other
   kind — if the fan runs constantly and stops during an alert, that is the
   symptom. */
#define RELAY_PIN        26
#define RELAY_ACTIVE_LOW 1

#define LCD_ADDRESS 0x27
#define LCD_COLS    16
#define LCD_ROWS    2

DHT dht(DHT_PIN, DHT_TYPE);
LiquidCrystal_I2C lcd(LCD_ADDRESS, LCD_COLS, LCD_ROWS);

/* ---------------------------------------------------------------- timing -- */
const unsigned long SAMPLE_INTERVAL_MS = 8000;   // matches the 8s design figure
const unsigned long LCD_PAGE_MS        = 2000;
const unsigned long WIFI_RETRY_MS      = 20000;

unsigned long lastSample = 0;
unsigned long lastLcdFlip = 0;
unsigned long lastWifiTry = 0;
uint8_t lcdPage = 0;

/* -------------------------------------------------------- offline buffer -- */
/*  When the network is down, readings are kept here and replayed later. Each
 *  carries a monotonic sequence number; the Worker has a unique index on
 *  (node_id, seq), so a replay can never be counted twice. This is what backs
 *  the "no data loss" claim — without the seq it would just be a retry.        */

#define BUFFER_SLOTS 48
#define PAYLOAD_MAX  224

struct Slot { char json[PAYLOAD_MAX]; bool used; };
Slot buffer[BUFFER_SLOTS];
uint8_t bufHead = 0, bufCount = 0;
uint32_t seqCounter = 0;

void bufferPush(const char* json) {
  uint8_t idx = (bufHead + bufCount) % BUFFER_SLOTS;
  if (bufCount == BUFFER_SLOTS) {
    // Full: drop the oldest. Losing the oldest sample is better than losing
    // the newest, because the newest is what an alert would fire on.
    bufHead = (bufHead + 1) % BUFFER_SLOTS;
    idx = (bufHead + bufCount - 1) % BUFFER_SLOTS;
  } else {
    bufCount++;
  }
  strncpy(buffer[idx].json, json, PAYLOAD_MAX - 1);
  buffer[idx].json[PAYLOAD_MAX - 1] = '\0';
  buffer[idx].used = true;
}

bool bufferPeek(char* out) {
  if (bufCount == 0) return false;
  strncpy(out, buffer[bufHead].json, PAYLOAD_MAX);
  return true;
}

void bufferPop() {
  if (bufCount == 0) return;
  buffer[bufHead].used = false;
  bufHead = (bufHead + 1) % BUFFER_SLOTS;
  bufCount--;
}

/* ---------------------------------------------------------------- exhaust -- */
/*  Automated mitigation. The relay opens when the local index crosses the
 *  critical band and closes once it has fallen back below the warning band —
 *  deliberately two different numbers.
 *
 *  A single threshold would chatter: a reading oscillating either side of 65
 *  would switch a mains relay several times a minute and destroy it. The gap
 *  between 65 and 40 is the hysteresis band, and MIN_RUN_MS stops a brief
 *  spike from producing a one-second pulse.
 *
 *  The node decides this locally rather than waiting for the server. If WiFi
 *  is down, the fan must still come on. */

#define EXHAUST_ON_INDEX   65.0f
#define EXHAUST_OFF_INDEX  40.0f
#define MIN_RUN_MS         60000UL

bool exhaustOn = false;
unsigned long exhaustSince = 0;

void relayWrite(bool on) {
#if RELAY_ACTIVE_LOW
  digitalWrite(RELAY_PIN, on ? LOW : HIGH);
#else
  digitalWrite(RELAY_PIN, on ? HIGH : LOW);
#endif
}

void updateExhaust(float index) {
  unsigned long now = millis();

  if (!exhaustOn && index >= EXHAUST_ON_INDEX) {
    exhaustOn = true;
    exhaustSince = now;
    relayWrite(true);
    Serial.println(F("[exhaust] ON — critical threshold crossed"));
    return;
  }

  if (exhaustOn && index <= EXHAUST_OFF_INDEX && (now - exhaustSince) >= MIN_RUN_MS) {
    exhaustOn = false;
    relayWrite(false);
    Serial.println(F("[exhaust] OFF — cleared, minimum run time met"));
  }
}

/* ------------------------------------------------------------------ hmac -- */
/*  Hex HMAC-SHA256 of the body, sent as X-Signature. The Worker recomputes it
 *  and compares in constant time.                                             */

void hmacHex(const char* message, char* outHex) {
  byte mac[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char*)DEVICE_KEY, strlen(DEVICE_KEY));
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)message, strlen(message));
  mbedtls_md_hmac_finish(&ctx, mac);
  mbedtls_md_free(&ctx);

  for (int i = 0; i < 32; i++) sprintf(outHex + (i * 2), "%02x", mac[i]);
  outHex[64] = '\0';
}

/* ------------------------------------------------------------------ wifi -- */
void wifiEnsure() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < WIFI_RETRY_MS) return;

  lastWifiTry = millis();
  Serial.println(F("[wifi] connecting"));
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Non-blocking-ish: cap the wait so sampling continues even with no network.
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) delay(250);

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(F("[wifi] up, ip "));
    Serial.println(WiFi.localIP());
    // Timestamps matter for buffered readings: a replayed sample must carry
    // the time it was taken, not the time it was finally delivered.
    configTime(8 * 3600, 0, "pool.ntp.org", "time.nist.gov");   // UTC+8, Malaysia
  } else {
    Serial.println(F("[wifi] failed, will retry"));
  }
}

bool timeReady() {
  return time(nullptr) > 1735689600;   // sometime after Jan 2025
}

void isoNow(char* out, size_t len) {
  time_t now = time(nullptr);
  struct tm tm_utc;
  gmtime_r(&now, &tm_utc);
  strftime(out, len, "%Y-%m-%dT%H:%M:%SZ", &tm_utc);
}

/* ------------------------------------------------------------------ post -- */
/*  Returns true only on a 2xx, so a failure leaves the reading in the buffer. */

bool postSigned(const char* body, bool replayed) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  // Cloudflare's certificate chain rotates, and pinning a root here means the
  // node dies silently whenever it changes. For a campus prototype the shared
  // HMAC is what actually authenticates the data, so transport verification is
  // relaxed. If this ever handles anything sensitive, pin the ISRG/Cloudflare
  // root instead and accept the maintenance.
  client.setInsecure();
  client.setTimeout(8000);

  char sig[65];
  hmacHex(body, sig);

  HTTPClient http;
  String url = String("https://") + INGEST_HOST + INGEST_PATH;
  if (!http.begin(client, url)) return false;

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Signature", sig);
  http.addHeader("X-Node-Id", NODE_ID);
  http.setTimeout(8000);

  int code = http.POST((uint8_t*)body, strlen(body));
  http.end();

  Serial.print(replayed ? F("[replay] HTTP ") : F("[post] HTTP "));
  Serial.println(code);

  if (code == 401) {
    Serial.println(F("[post] 401 — DEVICE_KEY does not match the Worker secret"));
  }
  return code >= 200 && code < 300;
}

/* Send anything the buffer is holding, oldest first. One per cycle keeps the
 * loop responsive rather than stalling on a long backlog.                     */
void drainBuffer() {
  if (bufCount == 0 || WiFi.status() != WL_CONNECTED) return;

  char pending[PAYLOAD_MAX];
  if (!bufferPeek(pending)) return;

  // Wrap it so the Worker knows not to raise alerts on historical data.
  char wrapped[PAYLOAD_MAX + 48];
  snprintf(wrapped, sizeof(wrapped), "{\"replayed\":true,\"readings\":[%s]}", pending);

  if (postSigned(wrapped, true)) {
    bufferPop();
    Serial.print(F("[replay] delivered, remaining "));
    Serial.println(bufCount);
  }
}

/* ----------------------------------------------------------------- sense -- */
struct Reading {
  float temperature, humidity;
  int mq5, mq6, mq7a, mq7b;
  bool valid;
};

Reading readSensors() {
  Reading r;
  r.mq5  = analogRead(MQ5_PIN);
  r.mq6  = analogRead(MQ6_PIN);
  r.mq7a = analogRead(MQ7_1_PIN);
  r.mq7b = analogRead(MQ7_2_PIN);
  r.humidity = dht.readHumidity();
  r.temperature = dht.readTemperature();

  // DHT11 fails a read fairly often. Keep the gas values, blank the climate
  // ones, and let the server store nulls rather than throwing the sample away.
  r.valid = !(isnan(r.temperature) || isnan(r.humidity));
  if (!r.valid) { r.temperature = NAN; r.humidity = NAN; }
  return r;
}

/* Local mirror of the server's index, purely so the LCD can show a status
 * without a round trip. The server value is authoritative.                    */
float odourIndex(const Reading& r) {
  auto n = [](float v, float ceiling) {
    float x = v / ceiling;
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  };
  float s = 0.20f  * n(r.mq5,  1200)
          + 0.45f  * n(r.mq6,  1200)
          + 0.175f * n(r.mq7a,  900)
          + 0.175f * n(r.mq7b,  900);
  return roundf(s * 1000) / 10.0f;
}

const char* bandOf(float idx) {
  if (idx >= 65) return "HAZARD";
  if (idx >= 40) return "WARNING";
  return "NORMAL";
}

/* ------------------------------------------------------------------- lcd -- */
/*  Rotates pages on a timer instead of delay(), so nothing blocks the loop.
 *  The old sketch spent 6 of every 8 seconds inside delay() calls.            */

void lcdRender(const Reading& r, float idx) {
  lcd.clear();
  switch (lcdPage) {
    case 0:
      lcd.setCursor(0, 0); lcd.print("Odour ");
      lcd.print(idx, 1);
      lcd.setCursor(0, 1); lcd.print(bandOf(idx));
      break;
    case 1:
      lcd.setCursor(0, 0);
      if (r.valid) { lcd.print("T "); lcd.print(r.temperature, 1); lcd.print((char)223); lcd.print("C"); }
      else         { lcd.print("T --"); }
      lcd.setCursor(0, 1);
      if (r.valid) { lcd.print("RH "); lcd.print(r.humidity, 0); lcd.print("%"); }
      else         { lcd.print("RH --"); }
      break;
    case 2:
      lcd.setCursor(0, 0); lcd.print("MQ5 "); lcd.print(r.mq5);
      lcd.setCursor(0, 1); lcd.print("MQ6 "); lcd.print(r.mq6);
      break;
    default:
      lcd.setCursor(0, 0);
      lcd.print(WiFi.status() == WL_CONNECTED ? "WiFi OK" : "WiFi DOWN");
      lcd.setCursor(0, 1);
      if (exhaustOn)         { lcd.print("EXHAUST ON"); }
      else if (bufCount > 0) { lcd.print("Queued "); lcd.print(bufCount); }
      else                   { lcd.print("Synced"); }
      break;
  }
}

/* ----------------------------------------------------------------- setup -- */
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\n=== Smart Odour Node ==="));

  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0); lcd.print("Odour Monitor");
  lcd.setCursor(0, 1); lcd.print("starting...");

  dht.begin();

  // 12-bit ADC across the full 0-3.3V range. Without the attenuation setting
  // everything above ~1.1V reads as 4095 and the sensors look permanently
  // saturated.
  analogReadResolution(12);
  analogSetPinAttenuation(MQ5_PIN,   ADC_11db);
  analogSetPinAttenuation(MQ6_PIN,   ADC_11db);
  analogSetPinAttenuation(MQ7_1_PIN, ADC_11db);
  analogSetPinAttenuation(MQ7_2_PIN, ADC_11db);

  // Drive the relay inactive BEFORE setting the pin to output. An ESP32 pin
  // floats during boot, and on an active-low board that reads as "on" — the
  // fan would kick for a moment every time the node resets.
  relayWrite(false);
  pinMode(RELAY_PIN, OUTPUT);
  relayWrite(false);

  for (int i = 0; i < BUFFER_SLOTS; i++) buffer[i].used = false;

  wifiEnsure();

  Serial.println(F("[warmup] MQ sensors need 24-48h powered on for stable"));
  Serial.println(F("[warmup] readings. Early values will drift downward."));
}

/* ------------------------------------------------------------------ loop -- */
void loop() {
  wifiEnsure();

  unsigned long now = millis();

  if (now - lastLcdFlip >= LCD_PAGE_MS) {
    lastLcdFlip = now;
    lcdPage = (lcdPage + 1) % 4;
  }

  if (now - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = now;

    Reading r = readSensors();
    float idx = odourIndex(r);
    updateExhaust(idx);
    lcdRender(r, idx);

    char ts[24] = "";
    bool haveTime = timeReady();
    if (haveTime) isoNow(ts, sizeof(ts));

    seqCounter++;

    char body[PAYLOAD_MAX];
    if (r.valid) {
      snprintf(body, sizeof(body),
        "{\"node_id\":\"%s\",\"zone_id\":%d,\"temperature\":%.1f,\"humidity\":%.1f,"
        "\"mq5\":%d,\"mq6\":%d,\"mq7_1\":%d,\"mq7_2\":%d,\"rssi\":%d,\"seq\":%lu%s%s%s}",
        NODE_ID, ZONE_ID, r.temperature, r.humidity,
        r.mq5, r.mq6, r.mq7a, r.mq7b, WiFi.RSSI(), (unsigned long)seqCounter,
        haveTime ? ",\"ts\":\"" : "", haveTime ? ts : "", haveTime ? "\"" : "");
    } else {
      snprintf(body, sizeof(body),
        "{\"node_id\":\"%s\",\"zone_id\":%d,"
        "\"mq5\":%d,\"mq6\":%d,\"mq7_1\":%d,\"mq7_2\":%d,\"rssi\":%d,\"seq\":%lu%s%s%s}",
        NODE_ID, ZONE_ID,
        r.mq5, r.mq6, r.mq7a, r.mq7b, WiFi.RSSI(), (unsigned long)seqCounter,
        haveTime ? ",\"ts\":\"" : "", haveTime ? ts : "", haveTime ? "\"" : "");
    }

    Serial.print(F("[sample] idx ")); Serial.print(idx, 1);
    Serial.print(F("  ")); Serial.println(bandOf(idx));

    if (!postSigned(body, false)) {
      bufferPush(body);
      Serial.print(F("[buffer] held, queue depth "));
      Serial.println(bufCount);
    }
  }

  drainBuffer();
  delay(20);   // yield to the WiFi stack
}
