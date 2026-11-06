/*
 * Smart Odour Monitoring System: sensor node
 * Board: ESP32 DevKit (ESP-WROOM-32) on a screw/pin expansion base
 *
 * Wiring
 *   GPIO32  MQ slot 1 AOUT through divider   (see docs/WIRING.md)
 *   GPIO33  MQ slot 2 AOUT through divider
 *   GPIO34  MQ slot 3 AOUT through divider
 *   GPIO35  MQ slot 4 AOUT through divider
 *   GPIO4   DHT11 data (3V3)
 *   GPIO21  LCD SDA, GPIO22 LCD SCL
 *   GPIO26  Fan relay IN, held on so the fan always runs (harmless if the fan is wired straight to 5V)
 * Slots in order: MQ-5, MQ-6, MQ-7 A, MQ-7 B, the same pins as the PSM 1 prototype.
 *
 * What it does, once a minute:
 *   read sensors -> work out Odour Index -> show on LCD -> queue -> send to Supabase
 * The LCD status never depends on the network. If the network is down readings wait in
 * the queue (12 hours worth) and are sent oldest first when it returns.
 *
 * Over USB it also prints one LIVE line every 5 seconds and one READING line a minute,
 * which tools/usb_node.py turns into plain English and a CSV file.
 */
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ArduinoOTA.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <DHT.h>
#include <LiquidCrystal_I2C.h>
#include <time.h>
#include "secrets.h"
#include "odour_index.h"

#define FIRMWARE "2.3.1"

// ---- hardware
const int MQ_PINS[odour::SENSORS] = {32, 33, 34, 35};
const int DHT_PIN = 4;
const int FAN_RELAY_PIN = 26;
const bool RELAY_ACTIVE_LOW = true;   // most 5V relay modules. If the fan will not run, set to false.
// AOUT reaches 5 V; the ESP32 input must stay below 3.3 V. A 10k/20k divider gives 2/3 of
// the voltage, so multiply back by 1.5. The PSM 1 prototype has no dividers: set this to
// true after adding them (docs/WIRING.md).
const bool HAS_DIVIDERS = false;
const float DIVIDER_GAIN = HAS_DIVIDERS ? 1.5f : 1.0f;
const float ADC_FULL_SCALE_VOLTS = 3.3f;

DHT dht(DHT_PIN, DHT11);
LiquidCrystal_I2C lcd(0x27, 16, 2);
Preferences store;

// ---- timing
const unsigned long SAMPLE_MS   = 60000UL;
const unsigned long SEND_MS     = 5000UL;
const unsigned long LCD_MS      = 3000UL;
const unsigned long LIVE_MS     = 5000UL;
const unsigned long WIFI_MS     = 20000UL;
const unsigned long WARMUP_MS   = 300000UL;       // 5 minutes for heaters after each power-on
const unsigned long LEARNING_S  = 86400UL;        // 24 hours to learn clean air on a new node
const int           SEND_BATCH  = 20;

// ---- state
struct Reading {
  time_t t;
  float  index;
  float  r[odour::SENSORS];
  float  tempC, humidity;   // NAN when the DHT11 read failed
  bool   learning;
};
odour::Fifo<Reading, 720> queue;     // 720 minutes = 12 hours

float baseline[odour::SENSORS] = {0, 0, 0, 0};
float lastIndex = 0, lastTemp = NAN, lastHum = NAN, lastRatio[odour::SENSORS] = {1, 1, 1, 1};
float noticeable = 30, strong = 60;  // replaced by the server's values on each reply
unsigned long learnedSeconds = 0;
bool haveReading = false;
int lcdPage = 0;

unsigned long tSample = 0, tSend = 0, tLcd = 0, tLive = 0, tWifi = 0, tSave = 0;
unsigned long failWait = SEND_MS;

// ---- helpers
float readVolts(int pin) {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) { sum += analogRead(pin); delay(2); }
  return (sum / 16.0f) / 4095.0f * ADC_FULL_SCALE_VOLTS * DIVIDER_GAIN;
}

bool clockReady() { return time(nullptr) > 1735689600; }  // after 1 Jan 2025

void lcdLine(int row, const String& s) {
  lcd.setCursor(0, row);
  String t = s;
  while (t.length() < 16) t += ' ';
  lcd.print(t.substring(0, 16));
}

// "4:32" or "23h"
String timeLeft(unsigned long seconds) {
  if (seconds >= 3600) return String(seconds / 3600 + 1) + "h";
  String sec = String(seconds % 60);
  return String(seconds / 60) + ":" + (sec.length() < 2 ? "0" : "") + sec;
}
// "Fuel gas    1.1x": name on the left, how many times clean air on the right.
String gasLine(const char* name, float ratio) {
  String v = String(ratio, 1) + "x", t = name;
  while (t.length() + v.length() < 16) t += ' ';
  return t + v;
}
String upper(String s) { s.toUpperCase(); return s; }

// One idea per screen, in words. Each screen shows for 3 seconds.
void updateLcd() {
  unsigned long up = millis();
  if (up < WARMUP_MS) {
    lcdLine(0, "Warming up");
    lcdLine(1, "Ready in " + timeLeft((WARMUP_MS - up) / 1000));
    return;
  }
  if (!haveReading) { lcdLine(0, "First reading..."); lcdLine(1, ""); return; }
  bool learning = learnedSeconds < LEARNING_S;
  switch (lcdPage) {
    case 0:
      if (learning) { lcdLine(0, "Learning air"); lcdLine(1, "Done in " + timeLeft(LEARNING_S - learnedSeconds)); }
      else { lcdLine(0, "Air: " + upper(odour::levelName(lastIndex, noticeable, strong))); lcdLine(1, "Odour " + String(lastIndex, 0) + " of 100"); }
      break;
    case 1:
      lcdLine(0, isnan(lastTemp) ? "Temp: no reading" : "Temperature " + String(lastTemp, 0) + "C");
      lcdLine(1, isnan(lastHum) ? "Check DHT11" : "Humidity " + String(lastHum, 0) + "%");
      break;
    case 2:
      lcdLine(0, "Gas vs clean air");
      lcdLine(1, "1.0x = same");
      break;
    case 3:
      lcdLine(0, gasLine("Fuel gas", lastRatio[0]));
      lcdLine(1, gasLine("Butane gas", lastRatio[1]));
      break;
    case 4:
      lcdLine(0, gasLine("CO gas A", lastRatio[2]));
      lcdLine(1, gasLine("CO gas B", lastRatio[3]));
      break;
    default:
      lcdLine(0, WiFi.status() == WL_CONNECTED ? "WiFi connected" : "No WiFi");
      lcdLine(1, queue.count() ? "To send: " + String(queue.count()) : (clockReady() ? "All data sent" : "Clock not set"));
  }
  lcdPage = (lcdPage + 1) % 6;
}

// For the USB tool. Raw values too, so a wiring fault shows up straight away.
void printLive() {
  int adc[odour::SENSORS];
  for (int i = 0; i < odour::SENSORS; i++) adc[i] = (int)analogRead(MQ_PINS[i]);
  float t = dht.readTemperature(), h = dht.readHumidity();
  Serial.printf("LIVE fw=%s up=%lu warm=%lu adc=%d,%d,%d,%d t=%.1f h=%.0f wifi=%d clock=%d\n", FIRMWARE, millis() / 1000,
                millis() < WARMUP_MS ? (WARMUP_MS - millis()) / 1000 : 0UL, adc[0], adc[1], adc[2], adc[3], t, h,
                WiFi.status() == WL_CONNECTED, clockReady());
}
// The USB tool sends "T1793984719" so readings can be time-stamped with no internet.
void readUsbCommands() {
  while (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    if (line.startsWith("T")) {
      struct timeval tv = { (time_t)line.substring(1).toInt(), 0 };
      if (tv.tv_sec > 1735689600) { settimeofday(&tv, nullptr); Serial.println("CLOCK set from USB"); }
    }
  }
}

// Wireless updates, so the node needs no USB once it is inside the enclosure. It only listens
// on the local network, needs the password, and stays off while the password is the placeholder.
bool otaOn = false;
void keepOta() {
  if (otaOn) { ArduinoOTA.handle(); return; }
  if (WiFi.status() != WL_CONNECTED || String(OTA_PASSWORD) == "CHANGE_ME") return;
  ArduinoOTA.setHostname("odour-node");
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() { lcdLine(0, "Updating code"); lcdLine(1, "Do not unplug"); });
  ArduinoOTA.onError([](ota_error_t e) { Serial.printf("OTA failed (%u)\n", e); });
  ArduinoOTA.begin();
  otaOn = true;
  Serial.printf("OTA ready at %s\n", WiFi.localIP().toString().c_str());
}

void keepWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - tWifi < WIFI_MS) return;
  tWifi = millis();
  // Says why it can't connect: a network it can't see is usually 5 GHz only or misnamed;
  // one it can see but can't join usually means a wrong password.
  static int tries = 0;
  int was = WiFi.status();
  WiFi.disconnect();
  if (tries++ % 5 == 0) {
    int found = WiFi.scanNetworks(), rssi = 0, chan = 0;
    bool seen = false;
    for (int i = 0; i < found && !seen; i++)
      if (WiFi.SSID(i) == WIFI_SSID) { seen = true; rssi = WiFi.RSSI(i); chan = WiFi.channel(i); }
    Serial.printf("WIFI target_seen=%d rssi=%d channel=%d networks=%d last_status=%d\n", seen, rssi, chan, found, was);
    WiFi.scanDelete();
  }
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);   // non-blocking: sensing carries on while it connects
}

void takeSample() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  bool climateOk = !(isnan(t) || isnan(h));
  lastTemp = climateOk ? t : NAN;
  lastHum  = climateOk ? h : NAN;
  float factor = odour::climateFactor(t, h, climateOk);

  Reading rd;
  for (int i = 0; i < odour::SENSORS; i++) {
    float rs = odour::rsFromVolts(readVolts(MQ_PINS[i])) * factor;
    baseline[i] = odour::updateBaseline(baseline[i], rs);
    rd.r[i] = odour::ratioOf(baseline[i], rs);
    lastRatio[i] = rd.r[i];
  }
  rd.index = odour::indexFromRatios(rd.r);
  rd.tempC = lastTemp;
  rd.humidity = lastHum;
  rd.learning = learnedSeconds < LEARNING_S;
  rd.t = time(nullptr);
  lastIndex = rd.index;
  haveReading = true;
  learnedSeconds += SAMPLE_MS / 1000;

  // A reading cannot be stored without a real time: time is the duplicate-proof key.
  if (clockReady()) queue.push(rd);

  // Save the learned baseline hourly so a power cut does not restart learning.
  if (millis() - tSave > 3600000UL) {
    tSave = millis();
    store.putBytes("base", baseline, sizeof(baseline));
    store.putULong("learned", learnedSeconds);
  }

  Serial.printf("READING index=%.1f level=%s ratios=%.2f,%.2f,%.2f,%.2f t=%.1f h=%.0f queued=%d dropped=%lu learning=%d\n",
                rd.index, odour::levelName(rd.index, noticeable, strong), rd.r[0], rd.r[1], rd.r[2], rd.r[3],
                rd.tempC, rd.humidity, queue.count(), queue.drops(), rd.learning);
}

String jsonNum(float v, int dp) { return isnan(v) ? String("null") : String(v, dp); }

String buildBody(int n) {
  String rows = "[";
  for (int i = 0; i < n; i++) {
    const Reading& rd = queue.peek(i);
    char ts[24];
    struct tm g;
    gmtime_r(&rd.t, &g);
    strftime(ts, sizeof(ts), "%Y-%m-%dT%H:%M:%SZ", &g);
    if (i) rows += ",";
    rows += "{\"t\":\"" + String(ts) + "\",\"i\":" + String(rd.index, 1) + ",\"r\":[";
    for (int k = 0; k < odour::SENSORS; k++) {
      if (k) rows += ",";
      rows += String(rd.r[k], 2);
    }
    rows += "],\"tc\":" + jsonNum(rd.tempC, 1) + ",\"h\":" + jsonNum(rd.humidity, 0) +
            ",\"l\":" + (rd.learning ? "true" : "false") + "}";
  }
  rows += "]";
  return "{\"p_device\":\"" DEVICE_ID "\",\"p_key\":\"" DEVICE_KEY "\",\"p_rows\":" + rows +
         ",\"p_meta\":{\"fw\":\"" FIRMWARE "\",\"rssi\":" + String(WiFi.RSSI()) +
         ",\"q\":" + String(queue.count()) + "}}";
}

float jsonField(const String& s, const char* name, float fallback) {
  int at = s.indexOf(String("\"") + name + "\"");
  if (at < 0) return fallback;
  int colon = s.indexOf(':', at);      // the database writes a space after the colon
  return colon < 0 ? fallback : s.substring(colon + 1).toFloat();
}

// Forget the clean-air reference, for when the node has moved to its real location.
void relearn() {
  for (int i = 0; i < odour::SENSORS; i++) baseline[i] = 0;
  learnedSeconds = 0;
  store.remove("base");
  store.putULong("learned", 0);
  Serial.println("RELEARN started");
}

bool restartAfterSend = false;
// A batch leaves the queue only after the server confirms it. If the reply is
// lost and the batch is sent again, the server counts those rows as duplicates.
void sendBatch() {
  if (queue.count() == 0 || WiFi.status() != WL_CONNECTED) return;
  int n = queue.count() < SEND_BATCH ? queue.count() : SEND_BATCH;

  WiFiClientSecure tls;
  tls.setInsecure();       // Encrypted. Certificate pinning would break the node when the cert rotates.
  HTTPClient http;
  http.setTimeout(10000);
  http.begin(tls, String("https://") + SUPABASE_HOST + "/rest/v1/rpc/ingest");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON);
  int code = http.POST(buildBody(n));
  if (code == 200) {
    String reply = http.getString();
    queue.pop(n);
    noticeable = jsonField(reply, "noticeable", noticeable);
    strong = jsonField(reply, "strong", strong);
    failWait = SEND_MS;
    Serial.printf("sent %d: %s\n", n, reply.c_str());
    // The website queues a command, and it arrives in the reply to the next upload.
    if (reply.indexOf("\"command\"") >= 0) {
      if (reply.indexOf("\"relearn\"") >= 0) relearn();
      else if (reply.indexOf("\"restart\"") >= 0) restartAfterSend = true;
    }
  } else {
    // Back off up to 5 minutes so a cloud outage is not hammered.
    failWait = min(failWait * 2, 300000UL);
    Serial.printf("send failed (%d), retry in %lus\n", code, failWait / 1000);
  }
  http.end();
  if (restartAfterSend) { Serial.println("RESTART requested"); delay(200); ESP.restart(); }
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(50);
  digitalWrite(FAN_RELAY_PIN, RELAY_ACTIVE_LOW ? LOW : HIGH);   // fan on
  pinMode(FAN_RELAY_PIN, OUTPUT);
  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  lcdLine(0, "Smart Odour");
  lcdLine(1, "Monitoring " FIRMWARE);
  dht.begin();
  analogReadResolution(12);
  for (int p : MQ_PINS) analogSetPinAttenuation(p, ADC_11db);

  store.begin("odour", false);
  store.getBytes("base", baseline, sizeof(baseline));
  learnedSeconds = store.getULong("learned", 0);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
}

void loop() {
  unsigned long now = millis();
  keepWifi();
  keepOta();
  readUsbCommands();
  if (now - tLive >= LIVE_MS) { tLive = now; printLive(); }
  if (now - tLcd >= LCD_MS) { tLcd = now; updateLcd(); }
  if (now >= WARMUP_MS && now - tSample >= SAMPLE_MS) { tSample = now; takeSample(); }   // first sample right after warm-up
  if (now - tSend >= failWait) { tSend = now; sendBatch(); }
  delay(20);
}
