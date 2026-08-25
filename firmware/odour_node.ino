/* ============================================================
 *  SMART ODOUR MONITORING — EDGE NODE
 *  Universiti Teknikal Malaysia Melaka
 *
 *  Ini versi asal Azira, ditukar dari AWS IoT + HiveMQ (MQTT)
 *  ke Cloudflare Workers (HTTPS + HMAC).
 *
 *  APA YANG DIKEKALKAN dari kod asal:
 *    - Pin, sensor, LCD, selang 8 saat
 *    - Kalibrasi suhu/kelembapan (compensation_ratio) — logik ini betul
 *      dan penting, sensor MQ memang terpengaruh dengan suhu dan lembapan
 *    - Struktur readSensors() dan susunan paparan LCD
 *
 *  APA YANG BERUBAH dan kenapa:
 *    1. MQTT dibuang. Cloudflare tiada MQTT broker, jadi guna HTTPS POST.
 *    2. Sijil AWS dibuang sepenuhnya. Kunci peribadi tidak sepatutnya ada
 *       dalam fail kod — sesiapa yang dapat fail ini boleh menyamar sebagai
 *       node ini. Ganti dengan HMAC-SHA256: setiap bacaan ditandatangani.
 *    3. delay(1500) dibuang. Empat delay = 6 saat tersekat dalam kitaran
 *       8 saat, jadi WiFi stack kelaparan. LCD sekarang tukar halaman
 *       guna pemasa, tiada blocking.
 *    4. Tambah buffer offline. Kalau WiFi putus, bacaan disimpan dan
 *       dihantar semula kemudian, tidak hilang.
 *    5. Tambah relay kipas ekzos — keputusan dibuat di node sendiri.
 *
 *  ------------------------------------------------------------
 *  PENDAWAIAN
 *  ------------------------------------------------------------
 *    GPIO 4   DHT11 DATA
 *    GPIO 32  MQ-5  AOUT
 *    GPIO 33  MQ-6  AOUT
 *    GPIO 34  MQ-7 #1 AOUT      (pin input sahaja)
 *    GPIO 35  MQ-7 #2 AOUT      (pin input sahaja)
 *    GPIO 21  LCD SDA
 *    GPIO 22  LCD SCL
 *    GPIO 26  Relay IN          (kipas ekzos)
 *    3V3      DHT11 + LCD VCC
 *    5V/VIN   MQ sensor VCC (semua empat)
 *    GND      semua GND — mesti dikongsi
 *
 *  Keempat-empat sensor MQ kekal di ADC1. ADC2 tidak boleh dibaca semasa
 *  WiFi aktif — sensor di situ berfungsi masa uji, kemudian beku sebaik
 *  sahaja node sambung WiFi. Nampak macam sensor rosak, sebenarnya konflik pin.
 *
 *  ------------------------------------------------------------
 *  SEBELUM UPLOAD
 *  ------------------------------------------------------------
 *    1. Salin secrets.example.h -> secrets.h, isi semua nilai.
 *    2. Kalau guna OLED, tukar DISPLAY_TYPE di bawah.
 *    3. Serial Monitor 115200.
 * ============================================================ */

#define DISPLAY_LCD_1602      1
#define DISPLAY_OLED_SSD1306  2
#define DISPLAY_TYPE  DISPLAY_LCD_1602

#define LCD_ADDRESS   0x27
#define OLED_ADDRESS  0x3C

#include <Wire.h>
#include <DHT.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include "mbedtls/md.h"

#if DISPLAY_TYPE == DISPLAY_LCD_1602
  #include <LiquidCrystal_I2C.h>
  LiquidCrystal_I2C lcd(LCD_ADDRESS, 16, 2);
#else
  #include <Adafruit_GFX.h>
  #include <Adafruit_SSD1306.h>
  Adafruit_SSD1306 oled(128, 64, &Wire, -1);
#endif

#include "secrets.h"

// ============================================================
// 1. KONFIGURASI PERKAKASAN
// ============================================================
#define DHT_PIN 4
#define DHT_TYPE DHT11
DHT dht(DHT_PIN, DHT_TYPE);

#define MQ5_PIN 32
#define MQ6_PIN 33
#define MQ7_1_PIN 34
#define MQ7_2_PIN 35

#define RELAY_PIN 26
// Kebanyakan modul relay 5V adalah ACTIVE LOW. Kalau kipas berpusing
// sepanjang masa dan berhenti masa amaran, tukar ke 0.
#define RELAY_ACTIVE_LOW 1

// Prototaip. Arduino biasanya jana sendiri, tapi menulisnya terus
// mengelakkan ralat pelik kalau susunan fungsi diubah kemudian.
void readSensors();
void displayShow(float, float, bool, float, float, float, float, float);
void drainBuffer();
void setup_wifi();

const unsigned long SENSOR_INTERVAL = 8000;
const unsigned long SCREEN_INTERVAL = 2000;
const unsigned long WIFI_RETRY      = 20000;

unsigned long lastReadingTime = 0, lastScreenTime = 0, lastWifiTry = 0;
uint8_t screenPage = 0;

// ============================================================
// 2. BUFFER OFFLINE
// ============================================================
// Kalau WiFi putus, bacaan disimpan di sini dan dihantar semula bila
// sambung balik. Setiap bacaan ada nombor 'seq' yang naik satu-satu.
// Pelayan ada unique index pada (node_id, seq), jadi bacaan yang sudah
// sampai akan dibuang, bukan dikira dua kali.
#define BUFFER_SLOTS 40
#define PAYLOAD_MAX  256

struct Slot { char json[PAYLOAD_MAX]; };
Slot buffer[BUFFER_SLOTS];
uint8_t bufHead = 0, bufCount = 0;
uint32_t seqCounter = 0;

void bufferPush(const char* json) {
  uint8_t idx = (bufHead + bufCount) % BUFFER_SLOTS;
  if (bufCount == BUFFER_SLOTS) {
    // Penuh: buang yang PALING LAMA. Bacaan lama kurang berguna
    // berbanding bacaan terkini, dan amaran guna yang terkini.
    bufHead = (bufHead + 1) % BUFFER_SLOTS;
    idx = (bufHead + bufCount - 1) % BUFFER_SLOTS;
  } else {
    bufCount++;
  }
  strncpy(buffer[idx].json, json, PAYLOAD_MAX - 1);
  buffer[idx].json[PAYLOAD_MAX - 1] = '\0';
}

// ============================================================
// 3. KIPAS EKZOS
// ============================================================
// Dua ambang, bukan satu. Kalau guna satu nombor sahaja, bacaan yang
// naik-turun di sekitar nilai itu akan hidup-matikan relay berpuluh kali
// seminit sampai rosak. Jurang antara 65 dan 40 itu hysteresis band.
//
// Keputusan dibuat di node, bukan di pelayan. Kalau WiFi putus, kipas
// mesti tetap hidup — pengudaraan keselamatan tak boleh bergantung
// pada rangkaian.
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
    Serial.println("[EXHAUST] ON - ambang kritikal dilepasi");
  } else if (exhaustOn && index <= EXHAUST_OFF_INDEX &&
             (now - exhaustSince) >= MIN_RUN_MS) {
    exhaustOn = false;
    relayWrite(false);
    Serial.println("[EXHAUST] OFF - sudah reda");
  }
}

// ============================================================
// 4. TANDATANGAN HMAC
// ============================================================
// Setiap payload ditandatangani dengan kunci yang dikongsi dengan
// pelayan. Pelayan kira semula dan banding. Ini membuktikan bacaan
// datang dari perkakasan kita, bukan sesiapa yang jumpa URL.
void hmacHex(const char* message, char* outHex) {
  byte hmacResult[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char*)DEVICE_KEY, strlen(DEVICE_KEY));
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)message, strlen(message));
  mbedtls_md_hmac_finish(&ctx, hmacResult);
  mbedtls_md_free(&ctx);
  for (int i = 0; i < 32; i++) sprintf(outHex + (i * 2), "%02x", hmacResult[i]);
  outHex[64] = '\0';
}

// ============================================================
// 5. PAPARAN
// ============================================================
void displayInit() {
#if DISPLAY_TYPE == DISPLAY_LCD_1602
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(2, 0); lcd.print("Smart Odour");
  lcd.setCursor(0, 1); lcd.print("MonitoringSystem");
#else
  if (!oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS)) {
    Serial.println("[OLED] tak jumpa - cuba 0x3D");
    return;
  }
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.println("Smart Odour");
  oled.println("MonitoringSystem");
  oled.display();
#endif
}

const char* bandOf(float idx) {
  if (idx >= 65) return "HAZARD";
  if (idx >= 40) return "WARNING";
  return "NORMAL";
}

// Halaman skrin bertukar guna pemasa, bukan delay(). Kod asal ada empat
// delay(1500) — 6 saat tersekat dalam kitaran 8 saat, WiFi tak sempat
// bernafas dan sambungan kerap putus.
void displayShow(float temperature, float humidity, bool climateOk,
                 float mq5, float mq6, float co1, float co2, float idx) {
#if DISPLAY_TYPE == DISPLAY_LCD_1602
  lcd.clear();
  switch (screenPage) {
    case 0:
      lcd.setCursor(0, 0); lcd.print("Odour Index:");
      lcd.setCursor(0, 1); lcd.print(idx, 1); lcd.print(" "); lcd.print(bandOf(idx));
      break;
    case 1:
      lcd.setCursor(0, 0); lcd.print("Temperature:");
      lcd.setCursor(0, 1);
      if (climateOk) { lcd.print(temperature, 1); lcd.print(" C"); }
      else           { lcd.print("Sensor Error!"); }
      break;
    case 2:
      lcd.setCursor(0, 0); lcd.print("Humidity:");
      lcd.setCursor(0, 1);
      if (climateOk) { lcd.print(humidity, 1); lcd.print(" %"); }
      else           { lcd.print("Sensor Error!"); }
      break;
    case 3:
      lcd.setCursor(0, 0); lcd.print("MQ5(Gas): "); lcd.print((int)mq5);
      lcd.setCursor(0, 1); lcd.print("MQ6(But): "); lcd.print((int)mq6);
      break;
    case 4:
      lcd.setCursor(0, 0); lcd.print("MQ7_1(CO):"); lcd.print((int)co1);
      lcd.setCursor(0, 1); lcd.print("MQ7_2(CO):"); lcd.print((int)co2);
      break;
    default:
      lcd.setCursor(0, 0);
      if (exhaustOn)         lcd.print("EXHAUST ON");
      else if (bufCount > 0) { lcd.print("Queued: "); lcd.print(bufCount); }
      else                   lcd.print("System OK");
      lcd.setCursor(0, 1);
      lcd.print(WiFi.status() == WL_CONNECTED ? "WiFi Connected" : "WiFi Down");
      break;
  }
#else
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);  oled.print("ODOUR INDEX");
  oled.setTextSize(3);
  oled.setCursor(0, 14); oled.print(idx, 1);
  oled.setTextSize(1);
  oled.setCursor(0, 42); oled.print(bandOf(idx));
  oled.setCursor(0, 54);
  if (screenPage == 0) {
    if (climateOk) { oled.print(temperature, 1); oled.print("C  "); oled.print(humidity, 0); oled.print("%"); }
    else             oled.print("DHT error");
  } else if (screenPage == 1) {
    oled.print("MQ5 "); oled.print((int)mq5); oled.print(" MQ6 "); oled.print((int)mq6);
  } else if (screenPage == 2) {
    oled.print("CO "); oled.print((int)co1); oled.print(" / "); oled.print((int)co2);
  } else {
    if (exhaustOn)         oled.print("EXHAUST ON");
    else if (bufCount > 0) { oled.print("Queued "); oled.print(bufCount); }
    else                   oled.print(WiFi.status() == WL_CONNECTED ? "Online" : "WiFi down");
  }
  oled.display();
#endif
}

// ============================================================
// 6. WIFI
// ============================================================
void setup_wifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < WIFI_RETRY) return;
  lastWifiTry = millis();

  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Kod asal ada while-loop tanpa had — kalau WiFi tiada, node tersekat
  // selamanya dan sensor pun tak dibaca. Sekarang ada had masa.
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) {
    delay(300);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("\nWiFi connected! IP: ");
    Serial.println(WiFi.localIP());
    // Bacaan dalam buffer kena bawa masa ia DIAMBIL, bukan masa dihantar.
    configTime(8 * 3600, 0, "pool.ntp.org", "time.nist.gov");
  } else {
    Serial.println("\nWiFi failed - 2.4GHz sahaja, tiada captive portal");
  }
}

bool timeReady() { return time(nullptr) > 1735689600; }

void isoNow(char* out, size_t len) {
  time_t now = time(nullptr);
  struct tm t;
  gmtime_r(&now, &t);
  strftime(out, len, "%Y-%m-%dT%H:%M:%SZ", &t);
}

// ============================================================
// 7. HANTAR DATA
// ============================================================
bool sendPayload(const char* body, bool replayed) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  // Cloudflare tukar sijil dari masa ke masa. Kalau kita pin sijil,
  // node akan mati senyap bila sijil bertukar. HMAC yang sahkan data.
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

  Serial.print(replayed ? "[REPLAY] HTTP " : "[SEND] HTTP ");
  Serial.println(code);
  if (code == 401) Serial.println("[SEND] 401 - DEVICE_KEY tak sama dengan pelayan");
  return code >= 200 && code < 300;
}

void drainBuffer() {
  if (bufCount == 0 || WiFi.status() != WL_CONNECTED) return;

  // Dibalut dengan replayed:true supaya pelayan tahu ini data lama dan
  // tidak menghantar amaran. Amaran untuk kejadian dua jam lepas itu bug.
  char wrapped[PAYLOAD_MAX + 48];
  snprintf(wrapped, sizeof(wrapped),
           "{\"replayed\":true,\"readings\":[%s]}", buffer[bufHead].json);

  if (sendPayload(wrapped, true)) {
    bufHead = (bufHead + 1) % BUFFER_SLOTS;
    bufCount--;
    Serial.print("[REPLAY] berjaya, tinggal "); Serial.println(bufCount);
  }
}

// ============================================================
// 8. SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n===== SMART ODOUR EDGE NODE =====");

  // Relay dimatikan SEBELUM pin jadi OUTPUT. Pin ESP32 terapung masa boot,
  // dan modul active-low baca itu sebagai ON — tanpa ini kipas tersentak
  // setiap kali node reset.
  relayWrite(false);
  pinMode(RELAY_PIN, OUTPUT);
  relayWrite(false);

  dht.begin();
  Wire.begin(21, 22);
  displayInit();

  // Kod asal guna pinMode(INPUT) sahaja. Tanpa ADC_11db, apa-apa bacaan
  // melebihi ~1.1V jadi 4095 dan sensor nampak tepu sepanjang masa.
  analogReadResolution(12);
  analogSetPinAttenuation(MQ5_PIN,   ADC_11db);
  analogSetPinAttenuation(MQ6_PIN,   ADC_11db);
  analogSetPinAttenuation(MQ7_1_PIN, ADC_11db);
  analogSetPinAttenuation(MQ7_2_PIN, ADC_11db);

  setup_wifi();

  Serial.println("[WARMUP] Sensor MQ perlu 24-48 jam hidup sebelum bacaan");
  Serial.println("[WARMUP] stabil. Bacaan awal akan menurun perlahan-lahan.");
}

// ============================================================
// 9. LOOP
// ============================================================
void loop() {
  setup_wifi();

  unsigned long currentTime = millis();

  if (currentTime - lastScreenTime >= SCREEN_INTERVAL) {
    lastScreenTime = currentTime;
    screenPage = (screenPage + 1) % 6;
  }

  if (currentTime - lastReadingTime >= SENSOR_INTERVAL) {
    lastReadingTime = currentTime;
    readSensors();
  }

  drainBuffer();
  delay(20);
}

// ============================================================
// 10. BACA SENSOR
// ============================================================
void readSensors() {
  float temperature = dht.readTemperature();
  float humidity    = dht.readHumidity();

  int raw_mq5   = analogRead(MQ5_PIN);
  int raw_mq6   = analogRead(MQ6_PIN);
  int raw_mq7_1 = analogRead(MQ7_1_PIN);
  int raw_mq7_2 = analogRead(MQ7_2_PIN);

  // Kod asal 'return' terus bila DHT gagal, jadi bacaan gas pun hilang.
  // DHT11 memang kerap gagal. Sekarang kita simpan bacaan gas dan hantar
  // suhu/kelembapan sebagai null.
  bool climateOk = !(isnan(temperature) || isnan(humidity));
  if (!climateOk) Serial.println("AMARAN: DHT11 gagal dibaca, gas tetap dihantar.");

  // ----------------------------------------------------------
  // EDGE COMPUTING: Kalibrasi Data  (dikekalkan dari kod asal)
  // ----------------------------------------------------------
  // Sensor MQ memang terpengaruh dengan suhu dan kelembapan, jadi
  // pampasan ini betul. Kalau DHT gagal, ratio = 1.0 (tiada pampasan)
  // supaya bacaan mentah tidak dirosakkan oleh nilai NaN.
  float temp_factor = 0.015;
  float hum_factor  = 0.005;
  float compensation_ratio = 1.0;
  if (climateOk) {
    compensation_ratio = 1.0 + temp_factor * (temperature - 25.0)
                             + hum_factor  * (humidity - 50.0);
    if (compensation_ratio < 0.5) compensation_ratio = 0.5;   // elak bahagi
    if (compensation_ratio > 2.0) compensation_ratio = 2.0;   // dengan nilai pelik
  }

  float comp_mq5   = raw_mq5   / compensation_ratio;
  float comp_mq6   = raw_mq6   / compensation_ratio;
  float comp_mq7_1 = raw_mq7_1 / compensation_ratio;
  float comp_mq7_2 = raw_mq7_2 / compensation_ratio;

  // Indeks bau 0-100. Sama formula dengan pelayan, dikira di sini juga
  // supaya relay dan skrin berfungsi walaupun WiFi putus.
  auto norm = [](float v, float ceiling) {
    float x = v / ceiling;
    return x < 0 ? 0.0f : (x > 1 ? 1.0f : x);
  };
  float idx = 100.0f * (0.200f * norm(comp_mq5,   1200)
                      + 0.450f * norm(comp_mq6,   1200)
                      + 0.175f * norm(comp_mq7_1,  900)
                      + 0.175f * norm(comp_mq7_2,  900));
  idx = roundf(idx * 10) / 10.0f;

  updateExhaust(idx);

  Serial.println("---------- EDGE NODE ----------");
  Serial.print("Odour Index: "); Serial.print(idx, 1);
  Serial.print("  ["); Serial.print(bandOf(idx)); Serial.println("]");
  if (climateOk) {
    Serial.print("Temp: "); Serial.print(temperature, 1); Serial.println(" C");
    Serial.print("Hum:  "); Serial.print(humidity, 1);    Serial.println(" %");
  }
  Serial.print("MQ-5    (Compensated): "); Serial.println(comp_mq5, 1);
  Serial.print("MQ-6    (Compensated): "); Serial.println(comp_mq6, 1);
  Serial.print("MQ-7 #1 (Compensated): "); Serial.println(comp_mq7_1, 1);
  Serial.print("MQ-7 #2 (Compensated): "); Serial.println(comp_mq7_2, 1);
  Serial.println("-------------------------------");

  displayShow(temperature, humidity, climateOk,
              comp_mq5, comp_mq6, comp_mq7_1, comp_mq7_2, idx);

  // ----------------------------------------------------------
  // BINA JSON PAYLOAD
  // ----------------------------------------------------------
  char ts[24] = "";
  bool haveTime = timeReady();
  if (haveTime) isoNow(ts, sizeof(ts));

  seqCounter++;

  char payload[PAYLOAD_MAX];
  if (climateOk) {
    snprintf(payload, sizeof(payload),
      "{\"node_id\":\"%s\",\"zone_id\":%d,\"location\":\"%s\","
      "\"temperature\":%.1f,\"humidity\":%.1f,"
      "\"mq5\":%.1f,\"mq6\":%.1f,\"mq7_1\":%.1f,\"mq7_2\":%.1f,"
      "\"rssi\":%d,\"seq\":%lu,\"exhaust\":%d%s%s%s}",
      NODE_ID, ZONE_ID, NODE_LOCATION,
      temperature, humidity,
      comp_mq5, comp_mq6, comp_mq7_1, comp_mq7_2,
      WiFi.RSSI(), (unsigned long)seqCounter, exhaustOn ? 1 : 0,
      haveTime ? ",\"ts\":\"" : "", haveTime ? ts : "", haveTime ? "\"" : "");
  } else {
    snprintf(payload, sizeof(payload),
      "{\"node_id\":\"%s\",\"zone_id\":%d,\"location\":\"%s\","
      "\"mq5\":%.1f,\"mq6\":%.1f,\"mq7_1\":%.1f,\"mq7_2\":%.1f,"
      "\"rssi\":%d,\"seq\":%lu,\"exhaust\":%d%s%s%s}",
      NODE_ID, ZONE_ID, NODE_LOCATION,
      comp_mq5, comp_mq6, comp_mq7_1, comp_mq7_2,
      WiFi.RSSI(), (unsigned long)seqCounter, exhaustOn ? 1 : 0,
      haveTime ? ",\"ts\":\"" : "", haveTime ? ts : "", haveTime ? "\"" : "");
  }

  // Satu talian sahaja sekarang, bukan dua. Kalau gagal, simpan dalam
  // buffer dan cuba lagi kemudian — bacaan tidak hilang.
  if (sendPayload(payload, false)) {
    Serial.println("[SUCCESS] Data sent to Cloudflare Worker");
  } else {
    bufferPush(payload);
    Serial.print("[BUFFER] disimpan, dalam baris gilir: ");
    Serial.println(bufCount);
  }
}
