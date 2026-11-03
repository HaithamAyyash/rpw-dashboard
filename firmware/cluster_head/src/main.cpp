// NAKHEL cluster head: forwards records from the uplink queue to the cloud. See README.md.
#include <Arduino.h>
#include <WiFi.h>
#include <esp_random.h>
#include <time.h>

#include <cstdio>
#include <cstring>

#include "app_queue.h"
#include "esp32_transport.h"
#include "lora_receiver.h"
#include "secrets.h"
#include "uplink.h"

AppQueue uplinkQueue;

namespace {

constexpr bool startsWith(const char* text, const char* prefix) {
  return *prefix == '\0' || (*text == *prefix && startsWith(text + 1, prefix + 1));
}
static_assert(!startsWith(NAKHEL_SERVER_URL, "https://") || sizeof(NAKHEL_ROOT_CA) > 1,
              "An https:// server needs NAKHEL_ROOT_CA in secrets.h");

constexpr uint32_t kWifiRetryMs = 30000;
constexpr uint32_t kUplinkStackBytes = 16384;  // TLS needs a large stack

class Esp32Platform : public nakhel::UplinkPlatform {
 public:
  bool linkReady() override { return WiFi.status() == WL_CONNECTED && epochSeconds() > kClockSetAfterS; }
  int64_t epochSeconds() override { return static_cast<int64_t>(time(nullptr)); }
  uint32_t uptimeSeconds() override { return static_cast<uint32_t>(esp_timer_get_time() / 1000000); }
  bool uplinkRssi(int16_t& rssiDbm) override {
    if (WiFi.status() != WL_CONNECTED) return false;
    rssiDbm = static_cast<int16_t>(WiFi.RSSI());
    return true;
  }
  uint32_t random() override { return esp_random(); }
  void log(const char* line) override { Serial.printf("[uplink] %s\n", line); }
};

Esp32Platform platform;
Esp32Transport* transport = nullptr;
nakhel::Uplink* uplink = nullptr;

void uplinkTask(void* /*unused*/) {
  for (;;) {
    const uint32_t waitMs = uplink->step(static_cast<uint64_t>(esp_timer_get_time() / 1000));
    // Never sleep long, so a new record or restored link is noticed; always yield to other tasks.
    vTaskDelay(pdMS_TO_TICKS(waitMs == 0 ? 1 : (waitMs > 1000 ? 1000 : waitMs)));
  }
}

void keepWifiUp() {
  static uint32_t lastTry = 0;
  if (WiFi.status() != WL_CONNECTED && millis() - lastTry > kWifiRetryMs) {
    lastTry = millis();
    Serial.println("[wifi] reconnecting");
    WiFi.reconnect();
  }
}

#ifdef NAKHEL_DEMO_SOURCE
constexpr uint8_t kDemoNodeId = 1;

void pushDemoMeasurement() {
  static uint32_t last = 0;
  static nakhel::UplinkRecord record;
  if (millis() - last < 60000 || !platform.linkReady()) return;
  last = millis();
  record.kind = nakhel::UplinkRecord::Kind::Measurement;
  record.measurement = nakhel::Measurement();
  record.measurement.nodeId = kDemoNodeId;
  record.measurement.timestampS = platform.epochSeconds();
  // Always a low score, so the demo can't raise infestation alerts or send email.
  record.measurement.confidence = static_cast<float>(esp_random() % 300) / 1000.0F;
  snprintf(record.measurement.modelVersion, sizeof(record.measurement.modelVersion), "demo-FAKE");
  const bool queued = uplinkQueue.push(record);
  Serial.printf("[demo] measurement %s, %u waiting\n", queued ? "queued" : "dropped: queue full",
                static_cast<unsigned>(uplinkQueue.count()));
}
#endif

}  // namespace

void setup() {
  Serial.begin(115200);
  if (startsWith(NAKHEL_SERVER_URL, "http://")) {
    Serial.println("[uplink] WARNING: plain http sends the API key unencrypted. Test bench only.");
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(NAKHEL_WIFI_SSID, NAKHEL_WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  transport = new Esp32Transport(NAKHEL_SERVER_URL, NAKHEL_API_KEY, NAKHEL_ROOT_CA);
  uplink = new nakhel::Uplink(*transport, uplinkQueue, platform);
  // Core 0, with the Wi-Fi stack. Sends block for up to 20 s, so the LoRa code stays free on core 1.
  xTaskCreatePinnedToCore(uplinkTask, "nakhel_uplink", kUplinkStackBytes, nullptr, 1, nullptr, 0);

  startLoraReceiver();
}

void loop() {
  keepWifiUp();
#ifdef NAKHEL_DEMO_SOURCE
  pushDemoMeasurement();
#endif
  delay(100);
}
