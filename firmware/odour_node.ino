/* ============================================================================
 *  Smart Odour Monitoring Platform — Edge Node 01
 *  UTeM Kolej Kediaman Lekiu
 *
 *  Dual-stream architecture (AWS removed):
 *    Stream A  HTTPS POST  -> Cloudflare Worker /ingest  (durable, system of record)
 *    Stream B  MQTT/TLS    -> HiveMQ Cloud               (realtime dashboard relay)
 *
 *  Reliability features:
 *    - 64-slot RAM ring buffer; readings survive network loss and replay on reconnect
 *    - Non-blocking LCD rotation (the old delay(1500) x4 blocked 6 of every 8 seconds)
 *    - Non-blocking reconnect with backoff; loop() never stalls
 *    - Node health telemetry (uptime, RSSI, free heap, buffered count, drop count)
 *
 *  Libraries: LiquidCrystal_I2C, DHT sensor library, PubSubClient, ArduinoJson
 * ========================================================================== */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>

#include "secrets.h"   // <-- see secrets_example.h. Keep this file OUT of git.

/* ---------------------------------------------------------------------------
 *  HARDWARE
 *  MQ pins are all on ADC1 (GPIO32-39). Do NOT move them to ADC2 (GPIO0,2,4,
 *  12-15,25-27) — ADC2 is unusable while WiFi is active on the ESP32.
 * ------------------------------------------------------------------------- */
#define DHT_PIN     4
#define DHT_TYPE    DHT11
#define MQ5_PIN     32
#define MQ6_PIN     33
#define MQ7_1_PIN   34
#define MQ7_2_PIN   35

#define LCD_ADDRESS 0x27
#define LCD_COLS    16
#define LCD_ROWS    2

DHT dht(DHT_PIN, DHT_TYPE);
LiquidCrystal_I2C lcd(LCD_ADDRESS, LCD_COLS, LCD_ROWS);

/* ---------------------------------------------------------------------------
 *  TIMING
 * ------------------------------------------------------------------------- */
const unsigned long SENSOR_INTERVAL   = 8000;   // read + publish cadence
const unsigned long LCD_PAGE_INTERVAL = 2000;   // screen rotation
const unsigned long MQTT_RETRY_MS     = 5000;   // backoff floor
const unsigned long WIFI_RETRY_MS     = 10000;
const unsigned long HEALTH_INTERVAL   = 60000;  // node health beacon

unsigned long lastReading = 0, lastLcdPage = 0, lastMqttTry = 0,
              lastWifiTry = 0, lastHealth  = 0;

/* ---------------------------------------------------------------------------
 *  NETWORK CLIENTS
 * ------------------------------------------------------------------------- */
WiFiClientSecure mqttTransport;
PubSubClient     mqtt(mqttTransport);

const char* MQTT_TOPIC  = "utem/bita/smartodour/node01";
const char* HEALTH_TOPIC = "utem/bita/smartodour/node01/health";

/* ---------------------------------------------------------------------------
 *  OFFLINE RING BUFFER
 *  Holds readings that failed to reach the Worker. Replayed oldest-first.
 *  64 slots x 8s = ~8.5 minutes of outage tolerance. Bump if you add PSRAM.
 * ------------------------------------------------------------------------- */
#define BUFFER_SLOTS 64
#define PAYLOAD_MAX  256

struct Slot { char json[PAYLOAD_MAX]; bool used; };
Slot   buffer[BUFFER_SLOTS];
int    bufHead = 0, bufTail = 0, bufCount = 0;
uint32_t droppedCount = 0, sentCount = 0, bufferedCount = 0;

void bufferPush(const char* json) {
  if (bufCount == BUFFER_SLOTS) {          // full: drop oldest, keep newest
    bufTail = (bufTail + 1) % BUFFER_SLOTS;
    bufCount--;
    droppedCount++;
  }
  strncpy(buffer[bufHead].json, json, PAYLOAD_MAX - 1);
  buffer[bufHead].json[PAYLOAD_MAX - 1] = '\0';
  buffer[bufHead].used = true;
  bufHead = (bufHead + 1) % BUFFER_SLOTS;
  bufCount++;
  bufferedCount++;
}

bool bufferPeek(char* out) {
  if (bufCount == 0) return false;
  strncpy(out, buffer[bufTail].json, PAYLOAD_MAX);
  return true;
}

void bufferPop() {
  if (bufCount == 0) return;
  buffer[bufTail].used = false;
  bufTail = (bufTail + 1) % BUFFER_SLOTS;
  bufCount--;
}

/* ---------------------------------------------------------------------------
 *  LATEST SNAPSHOT (for the LCD)
 * ------------------------------------------------------------------------- */
struct Snapshot {
  float temperature = NAN, humidity = NAN;
  float mq5 = 0, mq6 = 0, mq7_1 = 0, mq7_2 = 0;
  bool  valid = false;
} snap;

int lcdPage = 0;

/* ===========================================================================
 *  WIFI
 * ========================================================================= */
void wifiEnsure() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < WIFI_RETRY_MS) return;
  lastWifiTry = millis();

  Serial.printf("[WIFI] connecting to %s ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  // Deliberately NOT a blocking while-loop. loop() keeps servicing the LCD
  // and the buffer even with no network — that is the point of the redesign.
}

/* ===========================================================================
 *  STREAM B — MQTT to HiveMQ Cloud
 * ========================================================================= */
void mqttEnsure() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (mqtt.connected()) return;
  if (millis() - lastMqttTry < MQTT_RETRY_MS) return;
  lastMqttTry = millis();

  String clientId = "esp32_node01_";
  clientId += String((uint32_t)ESP.getEfuseMac(), HEX);

  Serial.print("[MQTT] connecting to HiveMQ ... ");
  if (mqtt.connect(clientId.c_str(), HIVEMQ_USER, HIVEMQ_PASS)) {
    Serial.println("OK");
  } else {
    Serial.printf("failed rc=%d\n", mqtt.state());
  }
}

void mqttPublish(const char* topic, const char* payload) {
  if (!mqtt.connected()) return;
  if (mqtt.publish(topic, payload)) {
    Serial.println("[MQTT] published");
  } else {
    Serial.println("[MQTT] publish failed (payload > buffer? call setBufferSize)");
  }
}

/* ===========================================================================
 *  STREAM A — HTTPS to Cloudflare Worker
 *  Returns true only on 2xx, so the caller knows whether to buffer.
 * ========================================================================= */
bool workerPost(const char* payload) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure https;
#if INSECURE_TLS
  https.setInsecure();          // dev only — see secrets_example.h
#else
  https.setCACert(ROOT_CA_ISRG_X1);
#endif
  https.setTimeout(8);

  HTTPClient http;
  if (!http.begin(https, INGEST_URL)) return false;

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);
  http.setTimeout(8000);

  int code = http.POST((uint8_t*)payload, strlen(payload));
  http.end();

  if (code >= 200 && code < 300) {
    Serial.printf("[HTTP] ingest OK (%d)\n", code);
    return true;
  }
  Serial.printf("[HTTP] ingest FAILED (%d)\n", code);
  return false;
}

/* Replay one buffered reading per cycle so a backlog drains without ever
 * blocking the live path. 64 slots clear in ~8.5 minutes. */
void bufferDrain() {
  if (bufCount == 0) return;
  char pending[PAYLOAD_MAX];
  if (!bufferPeek(pending)) return;
  if (workerPost(pending)) {
    bufferPop();
    sentCount++;
    Serial.printf("[BUF] replayed 1, %d remaining\n", bufCount);
  }
}

/* ===========================================================================
 *  SENSORS
 * ========================================================================= */
void readAndPublish() {
  float temperature = dht.readTemperature();
  float humidity    = dht.readHumidity();

  int raw5   = analogRead(MQ5_PIN);
  int raw6   = analogRead(MQ6_PIN);
  int raw7a  = analogRead(MQ7_1_PIN);
  int raw7b  = analogRead(MQ7_2_PIN);

  if (isnan(temperature) || isnan(humidity)) {
    Serial.println("[DHT] read failed, skipping cycle");
    return;
  }

  // Edge compensation — MQ sensor resistance drifts with temp/humidity.
  const float TEMP_FACTOR = 0.015f;
  const float HUM_FACTOR  = 0.005f;
  float ratio = 1.0f + TEMP_FACTOR * (temperature - 25.0f)
                     + HUM_FACTOR  * (humidity    - 50.0f);
  if (ratio < 0.5f) ratio = 0.5f;   // guard against divide-by-tiny

  snap.temperature = temperature;
  snap.humidity    = humidity;
  snap.mq5   = raw5  / ratio;
  snap.mq6   = raw6  / ratio;
  snap.mq7_1 = raw7a / ratio;
  snap.mq7_2 = raw7b / ratio;
  snap.valid = true;

  char payload[PAYLOAD_MAX];
  snprintf(payload, sizeof(payload),
    "{\"node_id\":\"ESP32_01\",\"zone_id\":1,"
    "\"temperature\":%.1f,\"humidity\":%.1f,"
    "\"mq5\":%.1f,\"mq6\":%.1f,\"mq7_1\":%.1f,\"mq7_2\":%.1f,"
    "\"rssi\":%d,\"uptime_s\":%lu}",
    temperature, humidity, snap.mq5, snap.mq6, snap.mq7_1, snap.mq7_2,
    WiFi.RSSI(), millis() / 1000UL);

  Serial.println("---------- EDGE NODE 01 ----------");
  Serial.println(payload);

  // Stream B first — cheap, non-durable, drives the live tiles.
  mqttPublish(MQTT_TOPIC, payload);

  // Stream A — durable. Buffer on failure, never lose the reading.
  if (workerPost(payload)) {
    sentCount++;
  } else {
    bufferPush(payload);
    Serial.printf("[BUF] stored, depth=%d dropped=%lu\n", bufCount, droppedCount);
  }
}

void publishHealth() {
  char h[PAYLOAD_MAX];
  snprintf(h, sizeof(h),
    "{\"node_id\":\"ESP32_01\",\"uptime_s\":%lu,\"rssi\":%d,"
    "\"free_heap\":%lu,\"buffer_depth\":%d,\"sent\":%lu,"
    "\"buffered\":%lu,\"dropped\":%lu}",
    millis() / 1000UL, WiFi.RSSI(), (unsigned long)ESP.getFreeHeap(),
    bufCount, sentCount, bufferedCount, droppedCount);
  mqttPublish(HEALTH_TOPIC, h);
}

/* ===========================================================================
 *  LCD — non-blocking page rotation
 * ========================================================================= */
void lcdTick() {
  if (millis() - lastLcdPage < LCD_PAGE_INTERVAL) return;
  lastLcdPage = millis();

  lcd.clear();

  if (!snap.valid) {
    lcd.setCursor(0, 0); lcd.print("Warming up...");
    lcd.setCursor(0, 1); lcd.print(WiFi.status() == WL_CONNECTED ? "WiFi OK" : "No WiFi");
    return;
  }

  switch (lcdPage) {
    case 0:
      lcd.setCursor(0, 0); lcd.print("Temp: ");
      lcd.print(snap.temperature, 1); lcd.print((char)223); lcd.print("C");
      lcd.setCursor(0, 1); lcd.print("Hum:  ");
      lcd.print(snap.humidity, 1); lcd.print(" %");
      break;
    case 1:
      lcd.setCursor(0, 0); lcd.print("MQ5 Gas: "); lcd.print((int)snap.mq5);
      lcd.setCursor(0, 1); lcd.print("MQ6 But: "); lcd.print((int)snap.mq6);
      break;
    case 2:
      lcd.setCursor(0, 0); lcd.print("MQ7 CO A:"); lcd.print((int)snap.mq7_1);
      lcd.setCursor(0, 1); lcd.print("MQ7 CO B:"); lcd.print((int)snap.mq7_2);
      break;
    case 3:
      lcd.setCursor(0, 0);
      lcd.print(WiFi.status() == WL_CONNECTED ? "NET OK  " : "NET DOWN");
      lcd.print(mqtt.connected() ? "MQ:UP" : "MQ:DN");
      lcd.setCursor(0, 1);
      lcd.print("Queue:"); lcd.print(bufCount);
      lcd.print(" S:");    lcd.print(sentCount);
      break;
  }
  lcdPage = (lcdPage + 1) % 4;
}

/* ===========================================================================
 *  SETUP / LOOP
 * ========================================================================= */
void setup() {
  Serial.begin(115200);
  delay(200);

  dht.begin();
  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();

  analogSetPinAttenuation(MQ5_PIN,   ADC_11db);   // full 0-3.3V range
  analogSetPinAttenuation(MQ6_PIN,   ADC_11db);
  analogSetPinAttenuation(MQ7_1_PIN, ADC_11db);
  analogSetPinAttenuation(MQ7_2_PIN, ADC_11db);

  lcd.setCursor(2, 0); lcd.print("Smart Odour");
  lcd.setCursor(0, 1); lcd.print("MonitoringSystem");

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

#if INSECURE_TLS
  mqttTransport.setInsecure();
#else
  mqttTransport.setCACert(ROOT_CA_ISRG_X1);
#endif

  mqtt.setServer(HIVEMQ_HOST, HIVEMQ_PORT);
  mqtt.setBufferSize(512);      // default 256 is tight for our payload + headers
  mqtt.setKeepAlive(30);

  Serial.println("[BOOT] Smart Odour node 01 ready");
}

void loop() {
  wifiEnsure();
  mqttEnsure();
  if (mqtt.connected()) mqtt.loop();

  unsigned long now = millis();

  if (now - lastReading >= SENSOR_INTERVAL) {
    lastReading = now;
    readAndPublish();
    bufferDrain();              // one replay per cycle
  }

  if (now - lastHealth >= HEALTH_INTERVAL) {
    lastHealth = now;
    publishHealth();
  }

  lcdTick();
}
