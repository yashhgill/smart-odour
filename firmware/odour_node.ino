/* ===========================================================================
 *  SMART ODOUR MONITORING PLATFORM — ESP32 EDGE NODE
 *  Universiti Teknikal Malaysia Melaka
 *
 *  ---------------------------------------------------------------------------
 *  WIRING
 *  ---------------------------------------------------------------------------
 *
 *   ESP32 pin   Connects to                    Notes
 *   ---------   ---------------------------    ----------------------------
 *   3V3         DHT11 VCC, display VCC         logic-level parts only
 *   5V / VIN    MQ sensor VCC  (all four)      MQ heaters need 5V
 *   GND         every GND                      MUST be common
 *
 *   GPIO 4      DHT11  DATA                    add 10k to 3V3 if unstable
 *   GPIO 32     MQ-5   AOUT
 *   GPIO 33     MQ-6   AOUT
 *   GPIO 34     MQ-7   AOUT  (#1)              input-only pin
 *   GPIO 35     MQ-7   AOUT  (#2)              input-only pin
 *   GPIO 21     display SDA                    I2C data
 *   GPIO 22     display SCL                    I2C clock
 *   GPIO 26     relay  IN                      exhaust fan
 *
 *  WHY THESE PINS
 *
 *   All four gas sensors are on ADC1. ADC2 pins (0, 2, 4, 12-15, 25-27) cannot
 *   be read while WiFi is active — a sensor there works on the bench and then
 *   freezes the moment the node joins the network, which looks like a dead
 *   sensor rather than a pin conflict. Do not move them.
 *
 *   GPIO 34 and 35 are input-only. Fine for sensors, but nothing can be driven
 *   from them.
 *
 *   GPIO 26 is an ADC2 pin, but it is used here as a digital output, so the
 *   WiFi restriction does not apply.
 *
 *  POWER
 *
 *   Four MQ heaters draw roughly 600-800 mA together. A laptop USB port often
 *   cannot supply that alongside the ESP32 and display. Board resetting,
 *   display flickering, or readings sagging when everything is connected are
 *   all brownout — use a 5V 2A supply.
 *
 *   Drive the FAN from its own supply through the relay contacts (COM and NO).
 *   Never power a fan from the ESP32 regulator.
 *
 *  RELAY
 *
 *   Most 5V relay boards are ACTIVE LOW — the coil energises when IN goes LOW.
 *   If the fan runs constantly and stops during an alert, set
 *   RELAY_ACTIVE_LOW to 0 below.
 *
 *  ---------------------------------------------------------------------------
 *  LIBRARIES  (Arduino IDE -> Library Manager)
 *  ---------------------------------------------------------------------------
 *   DHT sensor library        by Adafruit  (+ Adafruit Unified Sensor)
 *   Adafruit SSD1306          by Adafruit  ]  for the OLED
 *   Adafruit GFX Library      by Adafruit  ]
 *   LiquidCrystal I2C         by Frank de Brabander   only if using an LCD
 *
 *   Board: "ESP32 Dev Module", esp32 package by Espressif.
 *
 *  BEFORE UPLOADING
 *   1. Copy secrets.example.h to secrets.h and fill it in.
 *   2. Set DISPLAY_TYPE below to match your hardware.
 *   3. Upload, then open Serial Monitor at 115200.
 * =========================================================================== */

/* --------------------------------------------------------------------------
 *  DISPLAY SELECTION — set this to match what you actually have
 * -------------------------------------------------------------------------- */
#define DISPLAY_OLED_SSD1306  1   /* 128x64 OLED, the usual 0.96" module      */
#define DISPLAY_LCD_1602      2   /* 16x2 character LCD with I2C backpack     */
#define DISPLAY_NONE          3   /* serial output only                        */

#define DISPLAY_TYPE  DISPLAY_OLED_SSD1306

/* Blank OLED? Try 0x3D. This sketch prints every I2C address it finds at boot. */
#define OLED_ADDRESS  0x3C
#define OLED_WIDTH    128
#define OLED_HEIGHT   64
#define LCD_ADDRESS   0x27


#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <DHT.h>
#include <time.h>
#include "mbedtls/md.h"

#if DISPLAY_TYPE == DISPLAY_OLED_SSD1306
  #include <Adafruit_GFX.h>
  #include <Adafruit_SSD1306.h>
  Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);
#elif DISPLAY_TYPE == DISPLAY_LCD_1602
  #include <LiquidCrystal_I2C.h>
  LiquidCrystal_I2C lcd(LCD_ADDRESS, 16, 2);
#endif

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

#define SDA_PIN     21
#define SCL_PIN     22

DHT dht(DHT_PIN, DHT_TYPE);

/* ---------------------------------------------------------------- timing -- */
const unsigned long SAMPLE_INTERVAL_MS = 8000;   // matches the 8s design figure
const unsigned long SCREEN_PAGE_MS        = 2000;
const unsigned long WIFI_RETRY_MS      = 20000;

unsigned long lastSample = 0;
unsigned long lastPageFlip = 0;
unsigned long lastWifiTry = 0;
uint8_t page = 0;

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
  bool climateOk;
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
  r.climateOk = !(isnan(r.temperature) || isnan(r.humidity));
  if (!r.climateOk) { r.temperature = NAN; r.humidity = NAN; }
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

/* --------------------------------------------------------------- display -- */

void displayBegin() {
#if DISPLAY_TYPE == DISPLAY_OLED_SSD1306
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS)) {
    Serial.println(F("[oled] not found - try 0x3D, and check SDA/SCL"));
    return;
  }
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(F("Smart Odour"));
  display.println(F("starting..."));
  display.display();
#elif DISPLAY_TYPE == DISPLAY_LCD_1602
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0); lcd.print("Smart Odour");
  lcd.setCursor(0, 1); lcd.print("starting...");
#endif
}

/*  The index is the number someone reads from across a room, so on the OLED it
 *  gets the large type and everything else rotates underneath it.             */
void displayRender(const Reading& r, float idx) {
#if DISPLAY_TYPE == DISPLAY_OLED_SSD1306
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("ODOUR INDEX"));

  display.setTextSize(3);
  display.setCursor(0, 12);
  display.print(idx, 1);

  display.setTextSize(1);
  display.setCursor(0, 40);
  display.print(bandOf(idx));

  display.setCursor(0, 53);
  if (page == 0) {
    if (r.climateOk) { display.print(r.temperature, 1); display.print(F("C  "));
                       display.print(r.humidity, 0);    display.print(F("%")); }
    else             { display.print(F("climate sensor --")); }
  } else if (page == 1) {
    display.print(F("MQ5 ")); display.print(r.mq5);
    display.print(F(" MQ6 ")); display.print(r.mq6);
  } else if (page == 2) {
    display.print(F("CO ")); display.print(r.mq7a);
    display.print(F(" / "));  display.print(r.mq7b);
  } else {
    if (exhaustOn)                          display.print(F("EXHAUST ON"));
    else if (bufCount > 0)                { display.print(F("Queued ")); display.print(bufCount); }
    else if (WiFi.status() == WL_CONNECTED) display.print(F("Online"));
    else                                    display.print(F("WiFi down"));
  }
  display.display();

#elif DISPLAY_TYPE == DISPLAY_LCD_1602
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Odour "); lcd.print(idx, 1);
  lcd.setCursor(0, 1);
  if (page == 0)      lcd.print(bandOf(idx));
  else if (page == 1) { if (r.climateOk) { lcd.print(r.temperature, 1); lcd.print("C ");
                                           lcd.print(r.humidity, 0); lcd.print("%"); }
                        else lcd.print("climate --"); }
  else if (page == 2) { lcd.print("MQ6 "); lcd.print(r.mq6); }
  else                { if (exhaustOn) lcd.print("EXHAUST ON");
                        else if (bufCount) { lcd.print("Queued "); lcd.print(bufCount); }
                        else lcd.print("Online"); }
#endif
}

/*  Prints every I2C address found. If the display stays blank this tells you
 *  whether it is even on the bus, which saves a lot of rewiring.              */
void scanI2C() {
  Serial.println(F("[i2c] scanning..."));
  uint8_t found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print(F("[i2c] device at 0x"));
      if (addr < 16) Serial.print('0');
      Serial.println(addr, HEX);
      found++;
    }
  }
  if (!found) Serial.println(F("[i2c] nothing found - check SDA/SCL and power"));
}

/* ----------------------------------------------------------------- setup -- */
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\n=== Smart Odour Node ==="));

  Wire.begin(SDA_PIN, SCL_PIN);
  scanI2C();
  displayBegin();

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

  if (now - lastPageFlip >= SCREEN_PAGE_MS) {
    lastPageFlip = now;
    page = (page + 1) % 4;
  }

  if (now - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = now;

    Reading r = readSensors();
    float idx = odourIndex(r);
    updateExhaust(idx);
    displayRender(r, idx);

    char ts[24] = "";
    bool haveTime = timeReady();
    if (haveTime) isoNow(ts, sizeof(ts));

    seqCounter++;

    char body[PAYLOAD_MAX];
    if (r.climateOk) {
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
