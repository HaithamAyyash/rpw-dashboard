# NAKHEL cluster head firmware (ESP32)

Takes records from a buffer and delivers them to the cloud with stop-and-wait ARQ. Getting packets from the nodes into that buffer is the LoRa side's job.

```
nodes --LoRa--> LoRa code --> UplinkQueue --> Uplink (ARQ) --HTTP(S) POST--> server
                (teammate)    the boundary    runs in its own task on core 0
```

## How the ARQ works

| Part of ARQ | Here |
|---|---|
| Window | One record in flight, oldest first, so order is kept |
| Acknowledgement | The server's HTTP answer. It must be 201 `stored` or 200 `duplicate`, naming the same node and timestamp |
| Timeout | 5 s to connect, 15 s to read |
| Retransmission | The same record, byte for byte, after 5 s, doubling to a 10 min cap with up to 20% jitter. It never gives up |
| Duplicate detection | The server identifies a measurement by `(node, timestamp)`. A lost ACK leads to a retry, which is answered 200 `duplicate` |

What happens to the record at the head of the queue:

| Server answer | Action |
|---|---|
| 201 `stored`, 200 `duplicate` | Remove it, send the next one at once |
| 400, 413, 422 with a contract error code | Remove it and call `onRejected`, because retrying can't help |
| 401 `unauthorized` | Stop sending and keep the buffer. Needs a new key and a restart |
| Anything else, including no answer, 429, 5xx, and a 200, 400 or 401 page from a proxy or Wi-Fi login portal | Keep it and retry |

Cluster health goes out every 5 minutes, even during a backlog or a retry wait. It isn't retransmitted, because the next reading replaces it. Nothing is sent until Wi-Fi is up and NTP has set the clock.

## For the LoRa code

Fill in the TODOs in `src/lora_receiver.cpp`. It runs in its own task and adds each received packet to the queue like this:

```cpp
nakhel::UplinkRecord record;
record.kind = nakhel::UplinkRecord::Kind::Measurement;
record.measurement = nakhel::Measurement();
record.measurement.nodeId = packet.nodeId;     // 0-255
record.measurement.timestampS = recordedAt;    // Unix seconds, UTC. Set once and never change it
record.measurement.confidence = packet.confidence;  // probability of infestation, 0 to 1
snprintf(record.measurement.modelVersion, sizeof(record.measurement.modelVersion), "node-model-1");
record.measurement.hasRssi = true;             // optional, also snrDb and receivedAtS
record.measurement.rssiDbm = packet.rssi;
if (!uplinkQueue.push(record)) { /* queue full: this record was not kept */ }
```

`RamQueue::push` is safe to call from another task, but not from an interrupt. Node heartbeats use `Kind::NodeHealth` and `record.nodeHealth`.

**To use your own buffer** (flash or SD card), implement `UplinkQueue` in `lib/nakhel_uplink/src/uplink_queue.h` and pass it to `Uplink` in `setup()`:

- `peek()` returns the oldest record and doesn't remove it. It must return the same record until `remove()` is called.
- `remove()` is called only once that record is finished with.

### Rules that keep the data correct

- **Keep the timestamp fixed.** A new timestamp on a resend is a new measurement to the server, and it gets stored twice.
- **Two packets from one node need different timestamps.** Timestamps are in whole seconds, and a second measurement with the same node and second is discarded as a duplicate.
- **Don't stamp packets before the clock is set.** A 1970 timestamp is refused by the server for good. Hold the packet or wait until `time(nullptr)` is past 2024.
- **The default queue is RAM, 512 records.** A reboot or power cut loses what's in it, and when it's full new records are refused.

## Setup

1. Register the cluster head and its nodes. The key prints once:
   ```bash
   ./db.sh web npm run register-cluster -- --org al-ain-demo --name CH-ESP32 --nodes 1-4
   ```
2. Copy `include/secrets.example.h` to `include/secrets.h` and fill it in.
3. Flash with PlatformIO (VS Code extension or CLI), and watch the serial output at 115200:
   ```bash
   pio run -e esp32dev -t upload -t monitor        # real firmware
   pio run -e esp32dev_demo -t upload -t monitor   # adds a fake result from node 1 every minute
   ```

The ESP32 has to reach the server over the network. For anything but a test bench, use `https://` and set `NAKHEL_ROOT_CA` to the server's root certificate. Plain `http://` sends the API key unencrypted.

## Tests

No board needed:

```bash
./db.sh test-firmware    # unit tests, then the ARQ engine against the running API with faults injected
./db.sh firmware-build   # compile for the ESP32
```

These run the ARQ code on the build machine. They don't cover `src/` (Wi-Fi, TLS, NTP, the task), which is only compiled, so check it on a board.

## Files

| Path | What |
|---|---|
| `lib/nakhel_uplink/src/uplink.*` | ARQ engine |
| `lib/nakhel_uplink/src/uplink_queue.h` | The interface to the LoRa side |
| `lib/nakhel_uplink/src/ram_queue.h` | Default buffer |
| `lib/nakhel_uplink/src/records.h` | The record structs |
| `lib/nakhel_uplink/src/payload.*`, `response.*` | JSON bodies, and deciding what an answer means |
| `src/main.cpp`, `src/esp32_transport.*` | ESP32 only: Wi-Fi, NTP, task, HTTP(S) |
| `host/`, `test/`, `test_integration/` | Tests |
