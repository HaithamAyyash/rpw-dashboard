# Cluster Head → Cloud Contract

How a Raspberry Pi cluster head sends measurements to NAKHEL. The body's exact rules are in [`measurement.schema.json`](measurement.schema.json), generated from the server's validation code. A working client to copy is in [`tools/pi_client_example.py`](../../tools/pi_client_example.py).

## `POST /api/v1/ingest/measurements`

One call is one measurement from one node. Send it over HTTPS (TLS 1.2+) with a body under 64 KB; a normal measurement is about 3–6 KB.

### Authentication

```
Authorization: Bearer <API key>
```

Each cluster head has its own key, created when it's registered and shown once. It identifies both the cluster head and its organization, so neither goes in the body. Keep it out of logs and out of source control.

### Body

```json
{
  "node_id": 42,
  "timestamp": "2026-10-24T18:00:04Z",
  "mfcc": [
    [-312.4, 41.2, -3.7, 12.9, -8.1, 5.5, -2.2, 3.0, -1.4, 0.9, -0.6, 0.3, -0.2],
    "...30 rows in total, 13 numbers each"
  ]
}
```

| Field | Required | Type | Meaning |
|---|---|---|---|
| `node_id` | Yes | integer 0–255 | The node's LoRa ID. Unique only within this cluster head, and the node must already be registered under it |
| `timestamp` | Yes | ISO 8601 with time and zone | When the node recorded the sample. `Z` preferred; a bare date or local time is refused |
| `mfcc` | Yes | 30 × 13 numbers | Row = frame, column = coefficient. Magnitude up to 3.4e38; stored as 32-bit floats |
| `msg_id` | No | UUID | ID of the row in your SQLite buffer |
| `received_at` | No | ISO 8601 with zone | When the Pi received the LoRa packet |
| `snr_db` | No | number | From the LoRa packet |
| `rssi_dbm` | No | integer −200 to 20 | From the Pi's radio |
| `schema_version` | No | integer ≥ 1 | Defaults to 1 |

Other fields are ignored, so newer Pi software won't break against an older server.

### What to do with each answer

Every JSON answer includes `server_time`. Compare it with your clock to detect drift.

| Code | Body | The Pi should |
|---|---|---|
| **201** | `{"status": "stored", "node_id": ..., "timestamp": ..., "server_time": ...}` | Delete it from the buffer |
| **200** | `{"status": "duplicate", ...}` | Delete it from the buffer. The server already has this node and timestamp; the first copy is kept, even if this one differs |
| **400** | error | Stop retrying that message, move it to a local "rejected" table, log it |
| **413** | error | Same as 400 |
| **422** | error | Same as 400. The node isn't registered; the server keeps a copy and shows the organization |
| **401** | error | Stop sending and alert the operator (bad or revoked key). **Keep the buffer** |
| **429, 5xx, timeout, no network** | anything | Retry with exponential backoff: 5 s, doubling to a 10 min cap. Keep the message buffered |

An error body looks like this. `details` is present only on `invalid_body`.

```json
{
  "error": {
    "code": "invalid_body",
    "message": "Body does not match the measurement schema",
    "details": [{ "path": "mfcc", "message": "Too small: expected array to have >=30 items" }]
  },
  "server_time": "2026-10-24T18:00:09.123Z"
}
```

| `error.code` | Status | Meaning |
|---|---|---|
| `invalid_json` | 400 | Body isn't valid JSON. Python's `json.dumps` writes `NaN` by default, which isn't valid: pass `allow_nan=False` |
| `invalid_body` | 400 | Missing field, wrong type, or wrong matrix shape |
| `timestamp_in_future` | 400 | More than 10 minutes ahead of the server. Check the clocks |
| `timestamp_too_old` | 400 | Older than the 1-year retention period, e.g. a clock reset to 1970 |
| `body_too_large` | 413 | Over 64 KB |
| `unknown_node` | 422 | No active node with this LoRa ID under this cluster head |
| `unauthorized` | 401 | Missing, unknown or revoked key |
| `server_error` | 500 | Our fault; retry |

### Rules that matter

- **Retries are safe.** The server treats `(node, timestamp)` as the identity of a measurement. Resend freely, and resend the *same* timestamp: a new timestamp would store the measurement twice.
- **Delete from the buffer only after 200 or 201.** A timeout doesn't mean the server didn't store it. Retry, and you'll get 200.
- **Keep the node's timestamp through outages.** Don't replace it with the time of sending.
- **Use timeouts on every request.** The reference client uses 5 s to connect and 15 s to read.

### Try it with curl

Register a cluster head (the key prints once), then send a measurement:

```bash
./db.sh web npm run register-cluster -- --org al-ain-demo --name CH-TEST --nodes 1-4
```

```bash
KEY=nkh_...   # from the command above
MFCC=$(python3 -c "import json; print(json.dumps([[-312.4]+[1.5]*12]*30))")
curl -i http://127.0.0.1:3100/api/v1/ingest/measurements \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"node_id\": 1, \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"mfcc\": $MFCC}"
```

Run the same `curl` with the same timestamp to see `200 duplicate`.

## `POST /api/v1/ingest/node-health`

Forwards a node's heartbeat. The authentication, retry rules and error codes are the same as for measurements. The body rules are in [`node_health.schema.json`](node_health.schema.json). **This needs the firmware heartbeat (decision D2), which doesn't exist yet.** Until it does, the dashboard shows "no data yet" for battery and uptime.

```json
{ "node_id": 42, "timestamp": "2026-10-24T22:00:04Z", "battery_mv": 3900, "rssi_dbm": -101, "uptime_s": 86400 }
```

Only `node_id` and `timestamp` are required. `(node, timestamp)` identifies a heartbeat, so retries are safe. A node with heartbeats counts as offline after 56 hours of silence.

## `POST /api/v1/ingest/cluster-health`

The Pi's own status; the key says which cluster head it is. The body rules are in [`cluster_health.schema.json`](cluster_health.schema.json). Send one every few minutes: once a cluster head has reported, 15 minutes of silence raises a critical `cluster_offline` alert and emails the owners.

```json
{ "timestamp": "2026-10-24T22:00:04Z", "uptime_s": 86400, "rssi_dbm": -70, "sd_free_mb": 18000, "uplink_type": "4g", "buffered_count": 3 }
```

Only `timestamp` is required. `uplink_type` is `wifi` or `4g`.

## Not available yet

A batch endpoint is planned only if flushing a backlog turns out to be slow. Don't build against it yet.
