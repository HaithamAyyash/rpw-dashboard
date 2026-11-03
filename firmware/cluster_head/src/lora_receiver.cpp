// The LoRa side of the cluster head: fill in the two TODOs. README.md explains each one.
#include "lora_receiver.h"

#include <Arduino.h>
#include <time.h>

#include <cstdio>

#include "app_queue.h"

namespace {

constexpr uint32_t kReceiverStackBytes = 8192;
constexpr uint32_t kIdleDelayMs = 10;
// The model on the nodes. Change this whenever they get a new model, so the dashboard can tell results
// apart. Letters, digits, '.', '_' and '-' only.
constexpr const char* kNodeModelVersion = "node-model-1";

// TODO(LoRa) 1: replace with your packet layout.
struct RawPacket {
  uint8_t nodeId = 0;
  float confidence = 0;  // probability of infestation, 0 to 1
  int16_t rssiDbm = 0;
  float snrDb = 0;
};

// TODO(LoRa) 2: set up the radio here, and return true when a packet has been copied into `packet`.
// Reassemble and check it (CRC, duplicates over the air) before returning.
bool receivePacket(RawPacket& packet) {
  (void)packet;
  return false;
}

void receiverTask(void* /*unused*/) {
  RawPacket packet;
  nakhel::UplinkRecord record;

  for (;;) {
    if (!receivePacket(packet)) {
      vTaskDelay(pdMS_TO_TICKS(kIdleDelayMs));
      continue;
    }

    const int64_t now = static_cast<int64_t>(time(nullptr));
    if (now < kClockSetAfterS) {
      Serial.println("[lora] packet dropped: the clock isn't set yet");
      continue;
    }

    record = nakhel::UplinkRecord();
    record.kind = nakhel::UplinkRecord::Kind::Measurement;
    nakhel::Measurement& m = record.measurement;
    m.nodeId = packet.nodeId;
    m.confidence = packet.confidence;
    snprintf(m.modelVersion, sizeof(m.modelVersion), "%s", kNodeModelVersion);
    m.timestampS = now;  // use the node's own recording time instead if the packet carries one
    m.receivedAtS = now;
    m.hasRssi = true;
    m.rssiDbm = packet.rssiDbm;
    m.hasSnr = true;
    m.snrDb = packet.snrDb;

    if (!uplinkQueue.push(record)) {
      Serial.printf("[lora] packet from node %u dropped: buffer full\n", packet.nodeId);
    }
  }
}

}  // namespace

void startLoraReceiver() {
  // Core 1: the uplink and Wi-Fi run on core 0, so a slow send can't delay the radio.
  xTaskCreatePinnedToCore(receiverTask, "nakhel_lora", kReceiverStackBytes, nullptr, 2, nullptr, 1);
}
