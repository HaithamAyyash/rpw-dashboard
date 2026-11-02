import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/v1/ingest/measurements/route";
import { parseLoraIds, registerCluster } from "@/lib/admin";
import { pool } from "@/lib/db/pool";
import { measurementJsonSchema } from "@/scripts/gen-contracts";
import {
  body,
  isoAgo,
  makeOrg,
  mfcc,
  ownerQuery,
  type TestOrg,
} from "./helpers";

const URL = "http://test/api/v1/ingest/measurements";

function send(key: string | null, payload: unknown, raw = false) {
  return POST(
    new Request(URL, {
      method: "POST",
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body: raw ? (payload as string) : JSON.stringify(payload),
    }),
  );
}

let org: TestOrg;
let other: TestOrg;

beforeAll(async () => {
  org = await makeOrg();
  other = await makeOrg();
});

async function rejects(o: TestOrg) {
  return ownerQuery<{
    error_code: string;
    http_status: number;
    lora_id: number | null;
    request_body: string;
  }>(
    'SELECT error_code, http_status, lora_id, request_body FROM ingest_rejects WHERE org_id = $1 ORDER BY "time" DESC',
    [o.orgId],
  );
}

describe("201 stored", () => {
  it("stores a required-fields-only measurement as pending", async () => {
    const payload = body();
    const res = await send(org.apiKey, payload);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({
      status: "stored",
      node_id: 100,
      timestamp: payload.timestamp,
    });
    expect(Date.parse(json.server_time)).not.toBeNaN();

    const rows = await ownerQuery<{
      status: string;
      energy: number;
      schema_version: number;
      snr_db: null;
      ndims: number;
    }>(
      `SELECT f.status, f.energy, f.schema_version, f.snr_db, array_ndims(f.mfcc) AS ndims
       FROM acoustic_features f WHERE f.org_id = $1 AND f."timestamp" = $2`,
      [org.orgId, payload.timestamp],
    );
    expect(rows).toEqual([
      {
        status: "pending",
        energy: -312.5,
        schema_version: 1,
        snr_db: null,
        ndims: 2,
      },
    ]);
  });

  it("stores every optional field", async () => {
    const payload = body({
      msg_id: "4f8c1f5e-7b1d-4c3a-9f0e-2a6d8b7c1e30",
      received_at: isoAgo(50),
      snr_db: 7.5,
      rssi_dbm: -101,
      schema_version: 2,
    });
    expect((await send(org.apiKey, payload)).status).toBe(201);
    const [row] = await ownerQuery<Record<string, unknown>>(
      `SELECT msg_id, snr_db, rssi_dbm, schema_version, received_at IS NOT NULL AS has_received
       FROM acoustic_features WHERE org_id = $1 AND "timestamp" = $2`,
      [org.orgId, payload.timestamp],
    );
    expect(row).toEqual({
      msg_id: payload.msg_id,
      snr_db: 7.5,
      rssi_dbm: -101,
      schema_version: 2,
      has_received: true,
    });
  });

  it("accepts a time zone offset and stores the same instant", async () => {
    const instant = new Date(Date.now() - 7_200_000);
    instant.setUTCMilliseconds(0);
    const dubai = new Date(instant.getTime() + 4 * 3_600_000)
      .toISOString()
      .replace(".000Z", "+04:00");
    expect(
      (await send(org.apiKey, body({ node_id: 101, timestamp: dubai }))).status,
    ).toBe(201);
    const rows = await ownerQuery(
      'SELECT 1 FROM acoustic_features WHERE org_id = $1 AND "timestamp" = $2',
      [org.orgId, instant.toISOString()],
    );
    expect(rows).toHaveLength(1);
  });

  it("ignores unknown fields, so newer Pi software doesn't break", async () => {
    expect((await send(org.apiKey, body({ future_field: 1 }))).status).toBe(
      201,
    );
  });

  it("stores values too small for a real as zero, rather than failing with a 5xx", async () => {
    const matrix = mfcc(1);
    matrix[0]![1] = 1e-300;
    expect((await send(org.apiKey, body({ mfcc: matrix }))).status).toBe(201);
  });

  it("allows a timestamp 9 minutes ahead (minor clock drift)", async () => {
    const ts = new Date(Date.now() + 9 * 60_000).toISOString();
    expect((await send(org.apiKey, body({ timestamp: ts }))).status).toBe(201);
  });
});

describe("200 duplicate", () => {
  it("returns 200 and changes nothing", async () => {
    const payload = body();
    expect((await send(org.apiKey, payload)).status).toBe(201);
    const repeat = await send(org.apiKey, {
      ...payload,
      mfcc: mfcc(99),
      snr_db: 1,
    });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({
      status: "duplicate",
      node_id: 100,
      timestamp: payload.timestamp,
    });
    const rows = await ownerQuery<{ energy: number; snr_db: number | null }>(
      'SELECT energy, snr_db FROM acoustic_features WHERE org_id = $1 AND "timestamp" = $2',
      [org.orgId, payload.timestamp],
    );
    expect(rows).toEqual([{ energy: -312.5, snr_db: null }]);
  });

  it("treats the same instant in another time zone as the same measurement", async () => {
    const instant = new Date(Date.now() - 9_000_000);
    instant.setUTCMilliseconds(0);
    const utc = instant.toISOString();
    const offset = new Date(instant.getTime() + 4 * 3_600_000)
      .toISOString()
      .replace(".000Z", "+04:00");
    expect((await send(org.apiKey, body({ timestamp: utc }))).status).toBe(201);
    expect((await send(org.apiKey, body({ timestamp: offset }))).status).toBe(
      200,
    );
  });

  it("survives ten concurrent copies: one 201, the rest 200, one row", async () => {
    const payload = body();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => send(org.apiKey, payload)),
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    const rows = await ownerQuery(
      'SELECT 1 FROM acoustic_features WHERE org_id = $1 AND "timestamp" = $2',
      [org.orgId, payload.timestamp],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("400 bad request", () => {
  const rows30x13 = mfcc();
  const cases: [string, unknown][] = [
    ["missing node_id", { timestamp: isoAgo(5), mfcc: rows30x13 }],
    ["missing timestamp", { node_id: 100, mfcc: rows30x13 }],
    ["missing mfcc", { node_id: 100, timestamp: isoAgo(5) }],
    ["node_id not an integer", body({ node_id: 1.5 })],
    ["node_id a string", body({ node_id: "100" })],
    ["node_id below range", body({ node_id: -1 })],
    ["node_id above range", body({ node_id: 256 })],
    ["29 rows", body({ mfcc: rows30x13.slice(0, 29) })],
    ["31 rows", body({ mfcc: [...rows30x13, rows30x13[0]] })],
    ["12 columns", body({ mfcc: rows30x13.map((r) => r.slice(0, 12)) })],
    ["14 columns", body({ mfcc: rows30x13.map((r) => [...r, 1]) })],
    ["one short row", body({ mfcc: [...rows30x13.slice(0, 29), [1, 2]] })],
    [
      "null in matrix",
      body({
        mfcc: [...rows30x13.slice(0, 29), [null, ...rows30x13[0]!.slice(1)]],
      }),
    ],
    [
      "string in matrix",
      body({
        mfcc: [...rows30x13.slice(0, 29), ["1", ...rows30x13[0]!.slice(1)]],
      }),
    ],
    [
      "value too big for a real",
      body({
        mfcc: [...rows30x13.slice(0, 29), [1e39, ...rows30x13[0]!.slice(1)]],
      }),
    ],
    ["date only", body({ timestamp: "2026-10-24" })],
    ["no time zone", body({ timestamp: "2026-10-24T18:00:04" })],
    ["unparseable timestamp", body({ timestamp: "yesterday" })],
    ["impossible date", body({ timestamp: "2026-13-45T18:00:04Z" })],
    ["msg_id not a UUID", body({ msg_id: "abc" })],
    ["received_at without zone", body({ received_at: "2026-10-24T18:00:04" })],
    ["snr_db a string", body({ snr_db: "high" })],
    ["rssi_dbm out of range", body({ rssi_dbm: -500 })],
    ["rssi_dbm not an integer", body({ rssi_dbm: -90.5 })],
    ["schema_version zero", body({ schema_version: 0 })],
    ["body is an array", [1, 2, 3]],
    ["body is null", null],
  ];

  it.each(cases)("%s", async (_name, payload) => {
    const res = await send(org.apiKey, payload);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("invalid_body");
    expect(Array.isArray(json.error.details)).toBe(true);
    expect(json.server_time).toBeTruthy();
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["empty body", ""],
    ["NaN literal", '{"node_id":100,"mfcc":[[NaN]]}'],
    ["Infinity literal", '{"node_id":100,"mfcc":[[Infinity]]}'],
  ])("%s", async (_name, raw) => {
    const res = await send(org.apiKey, raw, true);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_json");
  });

  it("rejects 1e999, which JSON.parse turns into Infinity", async () => {
    const text = JSON.stringify(body()).replace("-312.5", "1e999");
    const res = await send(org.apiKey, text, true);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_body");
  });

  it("timestamp more than 10 minutes in the future", async () => {
    const ts = new Date(Date.now() + 11 * 60_000).toISOString();
    const res = await send(org.apiKey, body({ timestamp: ts }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("timestamp_in_future");
  });

  it("timestamp older than the retention period, e.g. a Pi clock reset to 1970", async () => {
    const res = await send(
      org.apiKey,
      body({ timestamp: "1970-01-01T00:00:10Z" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("timestamp_too_old");
  });

  it("logs the reject for the organization", async () => {
    const own = await makeOrg();
    await send(own.apiKey, body({ node_id: 100, mfcc: [] }));
    const [row] = await rejects(own);
    expect(row).toMatchObject({
      error_code: "invalid_body",
      http_status: 400,
      lora_id: 100,
    });
  });

  it("survives a NUL byte in a bad body", async () => {
    const own = await makeOrg();
    const res = await send(own.apiKey, "bad\u0000json", true);
    expect(res.status).toBe(400);
    const [row] = await rejects(own);
    expect(row?.request_body).toBe("badjson");
  });
});

describe("401 unauthorized", () => {
  it.each([
    ["no header", null],
    ["unknown key", "nkh_not-a-real-key"],
  ])("%s", async (_name, key) => {
    const res = await send(key, body());
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("unauthorized");
    expect(json.server_time).toBeTruthy();
  });

  it("wrong scheme", async () => {
    const res = await POST(
      new Request(URL, {
        method: "POST",
        headers: { authorization: `Basic ${org.apiKey}` },
        body: JSON.stringify(body()),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("revoked key", async () => {
    const own = await makeOrg();
    expect((await send(own.apiKey, body())).status).toBe(201);
    await ownerQuery(
      "UPDATE cluster_heads SET revoked = true WHERE cluster_id = $1",
      [own.clusterId],
    );
    expect((await send(own.apiKey, body())).status).toBe(401);
  });

  it("checks the key before reading the body", async () => {
    const res = await send("nkh_bad", "x".repeat(70 * 1024), true);
    expect(res.status).toBe(401);
  });

  it("stores only a hash of the key", async () => {
    const rows = await ownerQuery<{ api_key_hash: string }>(
      "SELECT api_key_hash FROM cluster_heads WHERE cluster_id = $1",
      [org.clusterId],
    );
    expect(rows[0]?.api_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.api_key_hash).not.toContain(org.apiKey);
  });
});

describe("413 too large", () => {
  it("rejects a body over 64 KB and logs it", async () => {
    const own = await makeOrg();
    const res = await send(own.apiKey, "x".repeat(64 * 1024 + 1), true);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error.code).toBe("body_too_large");
    expect(json.server_time).toBeTruthy();
    const [row] = await rejects(own);
    expect(row).toMatchObject({
      error_code: "body_too_large",
      http_status: 413,
    });
    expect(row!.request_body.length).toBeLessThanOrEqual(2048);
  });

  it("counts a chunked body with no Content-Length", async () => {
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 70; i += 1)
          controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    const res = await POST(
      new Request(URL, {
        method: "POST",
        headers: { authorization: `Bearer ${org.apiKey}` },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
  });

  it("a body of exactly 64 KB isn't rejected as too large", async () => {
    const res = await send(org.apiKey, " ".repeat(64 * 1024), true);
    expect(res.status).toBe(400);
  });

  it("a real measurement fits comfortably", () => {
    expect(
      JSON.stringify(body({ mfcc: mfcc(-312.123456) })).length,
    ).toBeLessThan(10 * 1024);
  });
});

describe("422 unknown node", () => {
  it("rejects and logs the whole body", async () => {
    const own = await makeOrg();
    const payload = body({ node_id: 42 });
    const res = await send(own.apiKey, payload);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("unknown_node");
    expect(json.server_time).toBeTruthy();
    const [row] = await rejects(own);
    expect(row).toMatchObject({
      error_code: "unknown_node",
      http_status: 422,
      lora_id: 42,
    });
    expect(JSON.parse(row!.request_body)).toEqual(payload);
  });

  it("a retired node's LoRa ID is unknown", async () => {
    const own = await makeOrg();
    await ownerQuery(
      "UPDATE nodes SET active = false WHERE org_id = $1 AND lora_id = 100",
      [own.orgId],
    );
    expect((await send(own.apiKey, body({ node_id: 100 }))).status).toBe(422);
  });

  it("a node under another cluster head of the same org is unknown to this key", async () => {
    const own = await makeOrg([100]);
    await registerCluster({
      orgSlug: own.slug,
      name: "CH-02",
      loraIds: [200],
    });
    expect((await send(own.apiKey, body({ node_id: 200 }))).status).toBe(422);
  });
});

describe("two organizations with the same LoRa IDs", () => {
  it("keeps them separate", async () => {
    const payloadA = body({ node_id: 100, mfcc: mfcc(-100) });
    const payloadB = { ...payloadA, mfcc: mfcc(-200) }; // same LoRa ID, same timestamp
    expect((await send(org.apiKey, payloadA)).status).toBe(201);
    expect((await send(other.apiKey, payloadB)).status).toBe(201);

    const rows = await ownerQuery<{
      org_id: string;
      energy: number;
      node_id: string;
      lora_id: number;
    }>(
      `SELECT f.org_id, f.energy, f.node_id, n.lora_id FROM acoustic_features f
       JOIN nodes n USING (node_id) WHERE f."timestamp" = $1`,
      [payloadA.timestamp],
    );
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.org_id === org.orgId)!;
    const b = rows.find((r) => r.org_id === other.orgId)!;
    expect(a.energy).toBe(-100);
    expect(b.energy).toBe(-200);
    expect(a.lora_id).toBe(b.lora_id);
    expect(a.node_id).not.toBe(b.node_id);
  });

  it("ignores any org or cluster in the body, keeping what the key says", async () => {
    const payload = body({ org_id: other.orgId, cluster_id: other.clusterId });
    expect((await send(org.apiKey, payload)).status).toBe(201);
    const rows = await ownerQuery<{ org_id: string; cluster_id: string }>(
      `SELECT org_id, cluster_id FROM acoustic_features f
       WHERE f."timestamp" = $1 AND f.org_id = ANY($2::uuid[])`,
      [payload.timestamp, [org.orgId, other.orgId]],
    );
    expect(rows).toEqual([{ org_id: org.orgId, cluster_id: org.clusterId }]);
  });

  it("a reject is visible only to the organization that caused it", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    await send(a.apiKey, body({ node_id: 77 }));
    expect(await rejects(a)).toHaveLength(1);
    expect(await rejects(b)).toHaveLength(0);
  });
});

describe("5xx", () => {
  it("answers 500, so the Pi retries, when the database fails", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const spy = vi
      .spyOn(pool(), "query")
      .mockRejectedValueOnce(new Error("db down") as never);
    const res = await send(org.apiKey, body());
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe("server_error");
    expect(json.server_time).toBeTruthy();
    expect(JSON.stringify(json)).not.toContain("db down");
    spy.mockRestore();
    error.mockRestore();
  });
});

describe("runs as the unprivileged web role", () => {
  it("isn't connected as the owner", async () => {
    const { rows } = await pool().query<{ current_user: string }>(
      "SELECT current_user",
    );
    expect(rows[0]?.current_user).toBe("nakhel_web");
  });

  it("leaves no organization set on the pooled connection", async () => {
    await send(org.apiKey, body());
    const { rows } = await pool().query<{ count: string }>(
      "SELECT count(*) FROM nodes",
    );
    expect(rows[0]?.count).toBe("0");
  });
});

describe("register-cluster", () => {
  it("parses LoRa ID ranges", () => {
    expect(parseLoraIds("100-102, 200,101")).toEqual([100, 101, 102, 200]);
    expect(() => parseLoraIds("256")).toThrow();
    expect(parseLoraIds("255")).toEqual([255]);
    expect(() => parseLoraIds("5-1")).toThrow();
    expect(() => parseLoraIds("abc")).toThrow();
  });

  it("adds nodes to an existing cluster head without changing its key", async () => {
    const own = await makeOrg([100]);
    const result = await registerCluster({
      orgSlug: own.slug,
      name: "CH-01",
      loraIds: [30],
    });
    expect(result.apiKey).toBeNull();
    expect(result.clusterId).toBe(own.clusterId);
    expect((await send(own.apiKey, body({ node_id: 30 }))).status).toBe(201);
  });

  it("fails for an unknown organization", async () => {
    await expect(
      registerCluster({ orgSlug: "nope", name: "X", loraIds: [] }),
    ).rejects.toThrow(/No organization/);
  });
});

describe("contract", () => {
  it("the committed JSON Schema matches the Zod schema", () => {
    const file = path.resolve(
      __dirname,
      "../../docs/contracts/measurement.schema.json",
    );
    expect(readFileSync(file, "utf8")).toBe(measurementJsonSchema());
  });
});
