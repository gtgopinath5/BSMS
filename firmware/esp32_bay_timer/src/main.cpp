// ============================================================
//  Baywatch ESP32 Bay Timer
//
//  The BACKEND is the single source of truth. This device NEVER
//  computes elapsed/remaining time — it only renders the state the
//  backend publishes (every second) and reacts to lifecycle events.
//
//  Subscribes:
//    bay/<n>/timer    retained JSON state  → display + colour
//    bay/<n>/start    → 1 beep
//    bay/<n>/pause    → freeze (state msgs already carry PAUSED)
//    bay/<n>/resume   → resume
//    bay/<n>/complete → completion melody, then DONE screen
//    bay/<n>/restart  → ESP.restart()
//    bay/<n>/test     → display/LED/buzzer self-test
//    bay/<n>/ota      → OTA firmware update (payload {"url": "..."} )
//
//  Publishes:
//    bay/<n>/hello      {firmware, ip}   on every (re)connect → backend resyncs
//    bay/<n>/telemetry  {firmware, ip, rssi}  every TELEMETRY_EVERY_MS
//
//  Colour stages (received from backend, NOT computed here):
//    green  100%→60%   orange 60%→20%   red 20%→0% and all overtime
//  Beeps: start=1, →orange=2, →red=3, complete=unique melody.
// ============================================================
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Adafruit_NeoPixel.h>
#include <TM1637Display.h>
#include <HTTPUpdate.h>
#include "config.h"

// ── topics ──────────────────────────────────────────────────
static char T_STATE[32], T_START[32], T_PAUSE[32], T_RESUME[32], T_COMPLETE[32];
static char T_RESTART[32], T_TEST[32], T_OTA[32], T_HELLO[32], T_TELEM[32];

WiFiClient        net;
PubSubClient      mqtt(net);
Adafruit_NeoPixel rgb(RGB_PIXELS, PIN_RGB, NEO_GRB + NEO_KHZ800);
TM1637Display     seg(PIN_TM_CLK, PIN_TM_DIO);

const uint8_t SEG_COLON = 0b01000000;          // ':' between MM and SS
String        lastColor = "";                  // for colour-transition beeps
String        lastStatus = "READY";
unsigned long lastTelemetry = 0;

// 'dOnE' on a 7-seg
const uint8_t SEG_DONE[] = {
  0b01011110, // d
  0b00111111, // O
  0b00110111, // N
  0b01111001, // E
};

// ── buzzer helpers ──────────────────────────────────────────
void beep(int freq, int ms) { tone(PIN_BUZZER, freq, ms); delay(ms + 30); noTone(PIN_BUZZER); }
void beeps(int n, int freq) { for (int i = 0; i < n; i++) { beep(freq, 110); delay(70); } }
void completionMelody() {                       // unique completion sound
  beep(1320, 120); beep(1660, 120); beep(1980, 220);
}

// ── RGB helpers ─────────────────────────────────────────────
void setRGB(uint8_t r, uint8_t g, uint8_t b) {
  for (int i = 0; i < RGB_PIXELS; i++) rgb.setPixelColor(i, rgb.Color(r, g, b));
  rgb.show();
}
void applyColor(const String& c) {
  if      (c == "green")  setRGB(0, 200, 60);
  else if (c == "orange") setRGB(255, 120, 0);
  else if (c == "red")    setRGB(230, 0, 0);
  else                    setRGB(0, 0, 0);
}

// ── display helpers ─────────────────────────────────────────
void showTime(long remaining) {
  long total = labs(remaining);
  int mm = total / 60; int ss = total % 60;
  if (mm > 99) mm = 99;
  int value = mm * 100 + ss;                    // MMSS
  seg.showNumberDecEx(value, SEG_COLON, true);  // leading zeros + colon
}
void showDone() { seg.setSegments(SEG_DONE); }
void showReady() { const uint8_t dash[] = {0x40,0x40,0x40,0x40}; seg.setSegments(dash); }

// ── handle a timer STATE message (the heart of the display) ─
void onState(const JsonDocument& d) {
  String status = d["status"] | "READY";
  String color  = d["color"]  | "green";
  long   remaining = d["remaining"] | 0;
  lastStatus = status;

  if (status == "DONE")        { showDone();  applyColor("green"); }
  else if (status == "READY")  { showReady(); applyColor(""); }
  else {                                        // RUNNING / PAUSED
    showTime(remaining);
    applyColor(color);
    // colour-transition beeps (only while actively counting)
    if (status == "RUNNING" && color != lastColor && lastColor != "") {
      if (color == "orange") beeps(2, 1800);
      else if (color == "red") beeps(3, 2200);
    }
  }
  lastColor = (status == "RUNNING" || status == "PAUSED") ? color : "";
}

// ── self-test (Test Display button) ─────────────────────────
void selfTest() {
  seg.setSegments((const uint8_t[]){0x76,0x76,0x76,0x76}); // 'HHHH'-ish all-on-ish
  uint8_t all[] = {0xff,0xff,0xff,0xff}; seg.setSegments(all);
  setRGB(0,200,60);  beep(1500,150);
  setRGB(255,120,0); beep(1800,150);
  setRGB(230,0,0);   beep(2200,150);
  setRGB(0,0,0);
  showReady();
}

// ── OTA (real; needs a firmware URL in the payload) ─────────
void doOTA(const JsonDocument& d) {
  const char* url = d["url"] | "";
  if (!url || !strlen(url)) { Serial.println("[ota] no url in payload — skipping"); return; }
  Serial.printf("[ota] updating from %s\n", url);
  seg.setSegments((const uint8_t[]){0x00,0x5C,0x78,0x00}); // 'oF' (Of/OTA)
  httpUpdate.rebootOnUpdate(true);
  t_httpUpdate_return r = httpUpdate.update(net, url);
  if (r == HTTP_UPDATE_FAILED)
    Serial.printf("[ota] failed (%d): %s\n", httpUpdate.getLastError(), httpUpdate.getLastErrorString().c_str());
}

// ── MQTT message router ─────────────────────────────────────
void onMessage(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (len) deserializeJson(doc, payload, len);

  if (!strcmp(topic, T_STATE))         onState(doc);
  else if (!strcmp(topic, T_START))    { beep(2000, 130); }            // 1 beep
  else if (!strcmp(topic, T_RESUME))   { beep(2000, 90); }
  else if (!strcmp(topic, T_PAUSE))    { /* display freezes via PAUSED state */ }
  else if (!strcmp(topic, T_COMPLETE)) { completionMelody(); showDone(); applyColor("green"); }
  else if (!strcmp(topic, T_RESTART))  { Serial.println("[cmd] restart"); delay(200); ESP.restart(); }
  else if (!strcmp(topic, T_TEST))     { selfTest(); }
  else if (!strcmp(topic, T_OTA))      { doOTA(doc); }
}

// ── publishers ──────────────────────────────────────────────
void publishHello() {
  JsonDocument d; d["firmware"] = FIRMWARE_VERSION; d["ip"] = WiFi.localIP().toString();
  char buf[96]; size_t n = serializeJson(d, buf);
  mqtt.publish(T_HELLO, (const uint8_t*)buf, n, false);
}
void publishTelemetry() {
  JsonDocument d;
  d["firmware"] = FIRMWARE_VERSION; d["ip"] = WiFi.localIP().toString(); d["rssi"] = WiFi.RSSI();
  char buf[110]; size_t n = serializeJson(d, buf);
  mqtt.publish(T_TELEM, (const uint8_t*)buf, n, false);
}

// ── connectivity ────────────────────────────────────────────
void buildTopics() {
  sprintf(T_STATE,    "%s/%d/timer",     MQTT_PREFIX, BAY_NUMBER);
  sprintf(T_START,    "%s/%d/start",     MQTT_PREFIX, BAY_NUMBER);
  sprintf(T_PAUSE,    "%s/%d/pause",     MQTT_PREFIX, BAY_NUMBER);
  sprintf(T_RESUME,   "%s/%d/resume",    MQTT_PREFIX, BAY_NUMBER);
  sprintf(T_COMPLETE, "%s/%d/complete",  MQTT_PREFIX, BAY_NUMBER);
  sprintf(T_RESTART,  "%s/%d/restart",   MQTT_PREFIX, BAY_NUMBER);
  sprintf(T_TEST,     "%s/%d/test",      MQTT_PREFIX, BAY_NUMBER);
  sprintf(T_OTA,      "%s/%d/ota",       MQTT_PREFIX, BAY_NUMBER);
  sprintf(T_HELLO,    "%s/%d/hello",     MQTT_PREFIX, BAY_NUMBER);
  sprintf(T_TELEM,    "%s/%d/telemetry", MQTT_PREFIX, BAY_NUMBER);
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.printf(" ok · %s\n", WiFi.localIP().toString().c_str());
}

void connectMQTT() {
  char cid[32]; sprintf(cid, "baywatch-timer-%d", BAY_NUMBER);
  while (!mqtt.connected()) {
    Serial.printf("[mqtt] connecting to %s:%d ...", MQTT_HOST, MQTT_PORT);
    bool ok = strlen(MQTT_USER)
      ? mqtt.connect(cid, MQTT_USER, MQTT_PASS)
      : mqtt.connect(cid);
    if (ok) {
      Serial.println(" connected");
      // subscribe to everything for this bay
      const char* subs[] = {T_STATE, T_START, T_PAUSE, T_RESUME, T_COMPLETE, T_RESTART, T_TEST, T_OTA};
      for (auto s : subs) mqtt.subscribe(s, 1);
      publishHello();          // backend re-publishes the retained state → instant resync
    } else {
      Serial.printf(" rc=%d, retry in 2s\n", mqtt.state());
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUZZER, OUTPUT);
  rgb.begin(); rgb.setBrightness(RGB_BRIGHTNESS); setRGB(0, 0, 0);
  seg.setBrightness(TM_BRIGHTNESS); showReady();
  buildTopics();
  connectWiFi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);
  mqtt.setCallback(onMessage);
  connectMQTT();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();

  unsigned long now = millis();
  if (now - lastTelemetry > TELEMETRY_EVERY_MS) {
    lastTelemetry = now;
    if (mqtt.connected()) publishTelemetry();
  }
}
