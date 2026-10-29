// ============================================================
//  Baywatch ESP32 Bay Timer — per-device configuration.
//  Copy/adjust for each bay. ONE firmware per bay.
// ============================================================
#pragma once

// ── Identity ────────────────────────────────────────────────
// MUST be the GLOBALLY-UNIQUE bay number shown in the admin
// "Timer Connection" page. All MQTT topics key on it:
//     bay/<BAY_NUMBER>/timer, bay/<BAY_NUMBER>/start, ...
#define BAY_NUMBER        1
#define FIRMWARE_VERSION  "1.0.0"

// ── WiFi ────────────────────────────────────────────────────
#define WIFI_SSID         "YOUR_WIFI_SSID"
#define WIFI_PASS         "YOUR_WIFI_PASSWORD"

// ── MQTT broker (the machine running the Baywatch backend / Mosquitto) ──
#define MQTT_HOST         "192.168.1.50"   // broker LAN IP (NOT localhost)
#define MQTT_PORT         1883
#define MQTT_USER         ""               // "" = anonymous (dev). Set for prod.
#define MQTT_PASS         ""
#define MQTT_PREFIX       "bay"            // must match backend MQTT_TOPIC_PREFIX

// ── Pins ────────────────────────────────────────────────────
// WS2812 RGB LED / ring (colour stages). 1 pixel is enough; a ring also works.
#define PIN_RGB           5
#define RGB_PIXELS        8
#define RGB_BRIGHTNESS    90               // 0-255

// TM1637 4-digit 7-segment display (MM:SS countdown)
#define PIN_TM_CLK        18
#define PIN_TM_DIO        19
#define TM_BRIGHTNESS     5                // 0-7

// Passive buzzer (beeps). Use a passive piezo so tone() can drive frequencies.
#define PIN_BUZZER        23

// ── Telemetry cadence ───────────────────────────────────────
#define TELEMETRY_EVERY_MS  15000          // heartbeat → registry last_seen / IP / fw
