import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/v1/auth/login/route";
import { POST as clusterHealth } from "@/app/api/v1/ingest/cluster-health/route";
import { POST as nodeHealth } from "@/app/api/v1/ingest/node-health/route";
import { GET as getInvite } from "@/app/api/v1/invites/[token]/route";
import { POST as acceptInvite } from "@/app/api/v1/invites/[token]/accept/route";
import { GET as getAlerts } from "@/app/api/v1/orgs/[orgId]/alerts/route";
import { PATCH as ackAlert } from "@/app/api/v1/orgs/[orgId]/alerts/[alertId]/route";
import { GET as getClassifications } from "@/app/api/v1/orgs/[orgId]/classifications/route";
import {
  GET as getClusters,
  POST as postCluster,
} from "@/app/api/v1/orgs/[orgId]/clusters/route";
import { POST as rotateKey } from "@/app/api/v1/orgs/[orgId]/clusters/[clusterId]/rotate-key/route";
import { POST as revokeKey } from "@/app/api/v1/orgs/[orgId]/clusters/[clusterId]/revoke/route";
import { GET as getOverview } from "@/app/api/v1/orgs/[orgId]/energy/overview/route";
import { GET as getExport } from "@/app/api/v1/orgs/[orgId]/export/[file]/route";
import { GET as getHealthClusters } from "@/app/api/v1/orgs/[orgId]/health/clusters/route";
import { GET as getHealthNodes } from "@/app/api/v1/orgs/[orgId]/health/nodes/route";
import { GET as getHistory } from "@/app/api/v1/orgs/[orgId]/history/route";
import { GET as getHistorySummary } from "@/app/api/v1/orgs/[orgId]/history/summary/route";
import {
  GET as getInvites,
  POST as postInvite,
} from "@/app/api/v1/orgs/[orgId]/invites/route";
import { DELETE as deleteInvite } from "@/app/api/v1/orgs/[orgId]/invites/[inviteId]/route";
import { GET as getLatency } from "@/app/api/v1/orgs/[orgId]/latency/route";
import { GET as getMap } from "@/app/api/v1/orgs/[orgId]/map/route";
import { GET as getMembers } from "@/app/api/v1/orgs/[orgId]/members/route";
import { DELETE as deleteMember } from "@/app/api/v1/orgs/[orgId]/members/[userId]/route";
import { GET as getEnergy } from "@/app/api/v1/orgs/[orgId]/nodes/[nodeId]/energy/route";
import { GET as getFeatures } from "@/app/api/v1/orgs/[orgId]/nodes/[nodeId]/features/route";
import { PATCH as patchNode } from "@/app/api/v1/orgs/[orgId]/nodes/[nodeId]/route";
import { POST as importNodes } from "@/app/api/v1/orgs/[orgId]/nodes/import/route";
import {
  GET as getNodes,
  POST as postNode,
} from "@/app/api/v1/orgs/[orgId]/nodes/route";
import { PATCH as patchOrg } from "@/app/api/v1/orgs/[orgId]/route";
import { GET as getTree } from "@/app/api/v1/orgs/[orgId]/trees/[nodeId]/route";
import { csvRow, parseCsv } from "@/lib/api/csv";
import { POST as ingest } from "@/app/api/v1/ingest/measurements/route";
import {
  body as measurement,
  makeOrg,
  ownerQuery,
  type TestOrg,
} from "./helpers";

const ORIGIN = (process.env.APP_ORIGIN ?? "").split(",")[0]!.trim();
const BASE = "http://test/api/v1";

type Handler = (
  request: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function cookieFor(
  email: string,
  password = "test-password",
): Promise<string> {
  const res = await login(
    new Request(`${BASE}/auth/login`, {
      method: "POST",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

function call(
  handler: Handler,
  params: Record<string, string>,
  cookie?: string,
  url = "http://test/x",
) {
  return handler(new Request(url, { headers: cookie ? { cookie } : {} }), {
    params: Promise.resolve(params),
  });
}

function write(
  handler: Handler,
  params: Record<string, string>,
  cookie: string | undefined,
  body?: unknown,
  { method = "POST", origin = ORIGIN as string | null } = {},
) {
  return handler(
    new Request("http://test/x", {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );
}

const ownerEmail = (org: TestOrg) => `${org.slug}@test.example`;

async function firstNode(org: TestOrg, loraId = 100): Promise<string> {
  const [row] = await ownerQuery<{ node_id: string }>(
    "SELECT node_id FROM nodes WHERE org_id = $1 AND lora_id = $2",
    [org.orgId, loraId],
  );
  return row!.node_id;
}

/** A stored, classified measurement, the way the worker would leave it. */
async function classified(
  org: TestOrg,
  loraId: number,
  confidence: number,
  minutesAgo: number,
) {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const res = await ingest(
    new Request("http://test/x", {
      method: "POST",
      headers: { authorization: `Bearer ${org.apiKey}` },
      body: JSON.stringify(
        measurement({
          node_id: loraId,
          timestamp: ts,
          snr_db: 8,
          rssi_dbm: -90,
        }),
      ),
    }),
  );
  expect(res.status).toBe(201);
  await ownerQuery(
    `INSERT INTO classification_results ("timestamp", org_id, node_id, label, confidence, model_version)
     SELECT $1, $2, node_id, $3, $4, 'test-model' FROM nodes WHERE org_id = $2 AND lora_id = $5`,
    [
      ts,
      org.orgId,
      confidence >= 0.5 ? "infested" : "healthy",
      confidence,
      loraId,
    ],
  );
  return ts;
}

async function addAlert(
  org: TestOrg,
  severity = "warning",
  alertType = "low_battery",
) {
  const nodeId = await firstNode(org);
  const [row] = await ownerQuery<{ alert_id: string }>(
    `INSERT INTO alert_log (org_id, "timestamp", node_id, alert_type, severity, message)
     VALUES ($1, now(), $2, $3, $4, 'test alert') RETURNING alert_id`,
    [org.orgId, nodeId, alertType, severity],
  );
  return row!.alert_id;
}

let a: TestOrg;
let b: TestOrg;
let cookieA: string;
let nodeA: string;
let nodeB: string;
let alertB: string;

beforeAll(async () => {
  a = await makeOrg([100, 101]);
  b = await makeOrg([100]);
  cookieA = await cookieFor(ownerEmail(a));
  nodeA = await firstNode(a);
  nodeB = await firstNode(b);
  await classified(a, 100, 0.1, 30);
  await classified(a, 101, 0.9, 20);
  await classified(b, 100, 0.9, 10);
  alertB = await addAlert(b);
  await addAlert(a, "critical", "infestation_detected");
  await addAlert(a, "warning", "low_battery");
});

describe("every organization endpoint: access", () => {
  const reads: [string, Handler, (org: TestOrg) => Record<string, string>][] = [
    ["alerts", getAlerts as Handler, () => ({})],
    ["classifications", getClassifications as Handler, () => ({})],
    ["clusters", getClusters as Handler, () => ({})],
    ["energy overview", getOverview as Handler, () => ({})],
    ["export", getExport as Handler, () => ({ file: "alerts.csv" })],
    ["health clusters", getHealthClusters as Handler, () => ({})],
    ["health nodes", getHealthNodes as Handler, () => ({})],
    ["history", getHistory as Handler, () => ({})],
    ["history summary", getHistorySummary as Handler, () => ({})],
    ["invites", getInvites as Handler, () => ({})],
    ["latency", getLatency as Handler, () => ({})],
    ["map", getMap as Handler, () => ({})],
    ["members", getMembers as Handler, () => ({})],
    ["node energy", getEnergy as Handler, () => ({ nodeId: "1" })],
    ["node features", getFeatures as Handler, () => ({ nodeId: "1" })],
    ["nodes", getNodes as Handler, () => ({})],
    ["tree detail", getTree as Handler, () => ({ nodeId: "1" })],
  ];

  it.each(reads)(
    "%s: 401 logged out, 404 for another organization",
    async (_name, handler, extra) => {
      expect(
        (await call(handler, { orgId: a.orgId, ...extra(a) })).status,
      ).toBe(401);
      const res = await call(handler, { orgId: b.orgId, ...extra(b) }, cookieA);
      expect(res.status).toBe(404);
      expect(
        (await call(handler, { orgId: "not-a-uuid", ...extra(a) }, cookieA))
          .status,
      ).toBe(404);
    },
  );

  const writes: [string, Handler, Record<string, string>, string, unknown][] = [
    ["org settings", patchOrg as Handler, {}, "PATCH", { name: "Hacked" }],
    [
      "acknowledge",
      ackAlert as Handler,
      { alertId: "1" },
      "PATCH",
      { acknowledged: true },
    ],
    ["invite", postInvite as Handler, {}, "POST", { email: "x@test.example" }],
    [
      "delete invite",
      deleteInvite as Handler,
      { inviteId: randomUUID() },
      "DELETE",
      undefined,
    ],
    [
      "remove member",
      deleteMember as Handler,
      { userId: randomUUID() },
      "DELETE",
      undefined,
    ],
    ["register cluster", postCluster as Handler, {}, "POST", { name: "CH-X" }],
    [
      "rotate key",
      rotateKey as Handler,
      { clusterId: randomUUID() },
      "POST",
      undefined,
    ],
    [
      "revoke",
      revokeKey as Handler,
      { clusterId: randomUUID() },
      "POST",
      undefined,
    ],
    [
      "add node",
      postNode as Handler,
      {},
      "POST",
      { lora_id: 1, tree_label: "x", cluster_id: randomUUID() },
    ],
    [
      "edit node",
      patchNode as Handler,
      { nodeId: "1" },
      "PATCH",
      { tree_label: "x" },
    ],
    ["import nodes", importNodes as Handler, {}, "POST", { csv: "a" }],
  ];

  it.each(writes)(
    "%s: 401, 404 and CSRF",
    async (_name, handler, params, method, body) => {
      expect(
        (
          await write(handler, { orgId: a.orgId, ...params }, undefined, body, {
            method,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await write(handler, { orgId: b.orgId, ...params }, cookieA, body, {
            method,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await write(handler, { orgId: a.orgId, ...params }, cookieA, body, {
            method,
            origin: null,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await write(handler, { orgId: a.orgId, ...params }, cookieA, body, {
            method,
            origin: "https://evil.example",
          })
        ).status,
      ).toBe(403);
    },
  );
});

describe("IDs from another organization are 404, even inside your own URL", () => {
  it("tree, energy and features", async () => {
    for (const handler of [getTree, getEnergy] as Handler[]) {
      expect(
        (await call(handler, { orgId: a.orgId, nodeId: nodeB }, cookieA))
          .status,
      ).toBe(404);
    }
    const features = await call(
      getFeatures as Handler,
      { orgId: a.orgId, nodeId: nodeB },
      cookieA,
    );
    expect((await features.json()).items).toEqual([]);
  });

  it("acknowledging, editing, rotating and revoking change nothing", async () => {
    const orgA = { orgId: a.orgId };
    expect(
      (
        await write(
          ackAlert as Handler,
          { ...orgA, alertId: alertB },
          cookieA,
          { acknowledged: true },
          { method: "PATCH" },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await write(
          patchNode as Handler,
          { ...orgA, nodeId: nodeB },
          cookieA,
          { tree_label: "hacked" },
          { method: "PATCH" },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await write(
          rotateKey as Handler,
          { ...orgA, clusterId: b.clusterId },
          cookieA,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await write(
          revokeKey as Handler,
          { ...orgA, clusterId: b.clusterId },
          cookieA,
        )
      ).status,
    ).toBe(404);
    const [alert] = await ownerQuery<{ acknowledged: boolean }>(
      "SELECT acknowledged FROM alert_log WHERE alert_id = $1",
      [alertB],
    );
    expect(alert!.acknowledged).toBe(false);
    const [cluster] = await ownerQuery<{ revoked: boolean }>(
      "SELECT revoked FROM cluster_heads WHERE cluster_id = $1",
      [b.clusterId],
    );
    expect(cluster!.revoked).toBe(false);
  });

  it("removing another organization's owner finds nothing", async () => {
    const [user] = await ownerQuery<{ user_id: string }>(
      "SELECT user_id FROM users WHERE email = $1",
      [ownerEmail(b)],
    );
    expect(
      (
        await write(
          deleteMember as Handler,
          { orgId: a.orgId, userId: user!.user_id },
          cookieA,
          undefined,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(404);
  });

  it("a node can't be moved onto another organization's cluster head", async () => {
    const res = await write(
      patchNode as Handler,
      { orgId: a.orgId, nodeId: nodeA },
      cookieA,
      { cluster_id: b.clusterId },
      { method: "PATCH" },
    );
    expect(res.status).toBe(400);
  });

  it("a LoRa ID clash on someone else's cluster head looks the same as no clash", async () => {
    // B's cluster head has LoRa 100 but not 123. Telling them apart would reveal B's radio IDs.
    const clash = await write(
      postNode as Handler,
      { orgId: a.orgId },
      cookieA,
      { lora_id: 100, tree_label: "x", cluster_id: b.clusterId },
    );
    const none = await write(postNode as Handler, { orgId: a.orgId }, cookieA, {
      lora_id: 123,
      tree_label: "x",
      cluster_id: b.clusterId,
    });
    expect(clash.status).toBe(none.status);
    expect(await clash.json()).toMatchObject({
      error: (await none.json()).error,
    });
  });

  it("a node can't be added to another organization's cluster head", async () => {
    const res = await write(postNode as Handler, { orgId: a.orgId }, cookieA, {
      lora_id: 40,
      tree_label: "x",
      cluster_id: b.clusterId,
    });
    expect(res.status).toBe(400);
  });
});

describe("alert log", () => {
  const alerts = (query = "") =>
    call(
      getAlerts as Handler,
      { orgId: a.orgId },
      cookieA,
      `http://test/x${query}`,
    ).then((r) => r.json());

  it("lists newest first, with only this organization's alerts", async () => {
    const json = await alerts();
    expect(json.items.length).toBe(2);
    expect(
      json.items.every((x: { message: string }) => x.message === "test alert"),
    ).toBe(true);
    expect(json.items[0].tree_label).toBeTruthy();
    expect(typeof json.items[0].alert_id).toBe("number");
    expect(json.has_more).toBe(false);
  });

  it("filters by severity and acknowledgement", async () => {
    expect((await alerts("?severity=critical")).items).toHaveLength(1);
    expect((await alerts("?severity=info")).items).toHaveLength(0);
    expect((await alerts("?acknowledged=true")).items).toHaveLength(0);
  });

  it("400 for a bad filter", async () => {
    const res = await call(
      getAlerts as Handler,
      { orgId: a.orgId },
      cookieA,
      "http://test/x?severity=nope",
    );
    expect(res.status).toBe(400);
  });

  it("acknowledging records who, and repeating keeps the first", async () => {
    const own = await makeOrg();
    const cookie = await cookieFor(ownerEmail(own));
    const alertId = await addAlert(own);
    const params = { orgId: own.orgId, alertId };
    const res = await write(
      ackAlert as Handler,
      params,
      cookie,
      { acknowledged: true },
      { method: "PATCH" },
    );
    expect(res.status).toBe(200);
    const first = await res.json();
    expect(first.acknowledged).toBe(true);
    const again = await write(
      ackAlert as Handler,
      params,
      cookie,
      { acknowledged: true },
      { method: "PATCH" },
    );
    expect((await again.json()).acknowledged_at).toBe(first.acknowledged_at);
    const list = await call(
      getAlerts as Handler,
      { orgId: own.orgId },
      cookie,
    ).then((r) => r.json());
    expect(list.items[0].acknowledged_by_name).toBe("Owner");
    const filtered = await call(
      getAlerts as Handler,
      { orgId: own.orgId },
      cookie,
      "http://test/x?acknowledged=false",
    ).then((r) => r.json());
    expect(filtered.items).toEqual([]);
  });

  it("can't un-acknowledge", async () => {
    const res = await write(
      ackAlert as Handler,
      { orgId: a.orgId, alertId: "1" },
      cookieA,
      { acknowledged: false },
      { method: "PATCH" },
    );
    expect(res.status).toBe(400);
  });

  it("alert IDs that aren't numbers are 404", async () => {
    const res = await write(
      ackAlert as Handler,
      { orgId: a.orgId, alertId: "abc" },
      cookieA,
      { acknowledged: true },
      { method: "PATCH" },
    );
    expect(res.status).toBe(404);
  });
});

describe("classifications", () => {
  const list = (query = "") =>
    call(
      getClassifications as Handler,
      { orgId: a.orgId },
      cookieA,
      `http://test/x${query}`,
    ).then((r) => r.json());

  it("latest per node by default, highest confidence first", async () => {
    const json = await list();
    expect(json.total).toBe(2);
    expect(json.items.map((x: { lora_id: number }) => x.lora_id)).toEqual([
      101, 100,
    ]);
    expect(json.items[0]).toMatchObject({
      label: "infested",
      model_version: "test-model",
      status: "alert",
    });
    expect(json.items[0]).not.toHaveProperty("total_count");
  });

  it("sorts and filters", async () => {
    expect((await list("?sort=confidence_asc")).items[0].lora_id).toBe(100);
    expect((await list("?sort=tree_asc")).items).toHaveLength(2);
    expect((await list("?label=healthy")).items).toHaveLength(1);
    expect((await list("?min_conf=0.5")).items).toHaveLength(1);
  });

  it("from, to or node_id returns every result instead", async () => {
    const json = await list(`?node_id=${nodeA}`);
    expect(json.items).toHaveLength(1);
    expect(json).toHaveProperty("has_more");
    expect(json.items[0].node_id).toBe(Number(nodeA));
  });
});

describe("history and features", () => {
  it("lists records with prediction and no matrix", async () => {
    const json = await call(
      getHistory as Handler,
      { orgId: a.orgId },
      cookieA,
    ).then((r) => r.json());
    expect(json.items).toHaveLength(2);
    const row = json.items.find((x: { lora_id: number }) => x.lora_id === 101);
    expect(row).toMatchObject({ snr_db: 8, rssi_dbm: -90, label: "infested" });
    expect(row.energy).toBeCloseTo(-312.5);
    expect(row).not.toHaveProperty("mfcc");
  });

  it("filters by node and summary counts match", async () => {
    const one = await call(
      getHistory as Handler,
      { orgId: a.orgId },
      cookieA,
      `http://test/x?node_id=${nodeA}`,
    ).then((r) => r.json());
    expect(one.items).toHaveLength(1);
    const summary = await call(
      getHistorySummary as Handler,
      { orgId: a.orgId },
      cookieA,
    ).then((r) => r.json());
    expect(summary).toEqual({ total_records: 2, positive_detections: 1 });
  });

  it("the full matrix comes only with include=mfcc", async () => {
    const params = { orgId: a.orgId, nodeId: nodeA };
    const plain = await call(getFeatures as Handler, params, cookieA).then(
      (r) => r.json(),
    );
    expect(plain.items[0]).not.toHaveProperty("mfcc");
    const full = await call(
      getFeatures as Handler,
      params,
      cookieA,
      "http://test/x?include=mfcc",
    ).then((r) => r.json());
    expect(full.items[0].mfcc).toHaveLength(30);
    expect(full.items[0].mfcc[0]).toHaveLength(13);
  });

  it("an empty date range is empty, and a bad date is 400", async () => {
    const empty = await call(
      getHistory as Handler,
      { orgId: a.orgId },
      cookieA,
      "http://test/x?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z",
    ).then((r) => r.json());
    expect(empty.items).toEqual([]);
    expect(
      (
        await call(
          getHistory as Handler,
          { orgId: a.orgId },
          cookieA,
          "http://test/x?from=soon",
        )
      ).status,
    ).toBe(400);
  });
});

describe("energy", () => {
  it("per node, in time buckets", async () => {
    const json = await call(
      getEnergy as Handler,
      { orgId: a.orgId, nodeId: nodeA },
      cookieA,
    ).then((r) => r.json());
    expect(json.items).toHaveLength(1);
    expect(json.items[0].avg_energy).toBeCloseTo(-312.5);
    expect(json.items[0].measurements).toBe(1);
  });

  it("overview groups by current status", async () => {
    const json = await call(
      getOverview as Handler,
      { orgId: a.orgId },
      cookieA,
    ).then((r) => r.json());
    expect(
      new Set(json.items.map((x: { status: string }) => x.status)),
    ).toEqual(new Set(["healthy", "alert"]));
    expect(json.items[0].nodes).toBe(1);
  });

  it("400 for an unknown bucket", async () => {
    expect(
      (
        await call(
          getOverview as Handler,
          { orgId: a.orgId },
          cookieA,
          "http://test/x?bucket=1y",
        )
      ).status,
    ).toBe(400);
  });
});

describe("tree detail", () => {
  it("returns the tree", async () => {
    const json = await call(
      getTree as Handler,
      { orgId: a.orgId, nodeId: nodeA },
      cookieA,
    ).then((r) => r.json());
    expect(json).toMatchObject({
      node_id: Number(nodeA),
      lora_id: 100,
      status: "healthy",
      cluster_name: "CH-01",
    });
  });

  it("404 for a bad ID", async () => {
    expect(
      (
        await call(
          getTree as Handler,
          { orgId: a.orgId, nodeId: "abc" },
          cookieA,
        )
      ).status,
    ).toBe(404);
  });
});

describe("map", () => {
  it("returns only located nodes, plus cluster heads", async () => {
    const own = await makeOrg([100, 101]);
    const cookie = await cookieFor(ownerEmail(own));
    await ownerQuery(
      "UPDATE nodes SET location_lat = 24.2, location_lon = 55.7 WHERE org_id = $1 AND lora_id = 100",
      [own.orgId],
    );
    const json = await call(
      getMap as Handler,
      { orgId: own.orgId },
      cookie,
    ).then((r) => r.json());
    expect(json.nodes).toHaveLength(1);
    expect(json.nodes[0]).toMatchObject({
      lora_id: 100,
      status: "unknown",
      location_lat: 24.2,
    });
    expect(json.clusters[0]).toMatchObject({ name: "CH-01", node_count: 2 });
  });
});

describe("health", () => {
  it("nodes show no data until a heartbeat arrives, then they do", async () => {
    const own = await makeOrg([100]);
    const cookie = await cookieFor(ownerEmail(own));
    const before = await call(
      getHealthNodes as Handler,
      { orgId: own.orgId },
      cookie,
    ).then((r) => r.json());
    expect(before.items[0]).toMatchObject({
      battery_mv: null,
      uptime_s: null,
      last_heartbeat: null,
    });

    const res = await nodeHealth(
      new Request("http://test/x", {
        method: "POST",
        headers: { authorization: `Bearer ${own.apiKey}` },
        body: JSON.stringify({
          node_id: 100,
          timestamp: new Date().toISOString(),
          battery_mv: 3900,
          rssi_dbm: -90,
          uptime_s: 7200,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const after = await call(
      getHealthNodes as Handler,
      { orgId: own.orgId },
      cookie,
    ).then((r) => r.json());
    expect(after.items[0]).toMatchObject({
      battery_mv: 3900,
      rssi_dbm: -90,
      uptime_s: 7200,
    });
    expect(after.total).toBe(1);
  });

  it("clusters show no data until a report arrives, then they do", async () => {
    const own = await makeOrg([100]);
    const cookie = await cookieFor(ownerEmail(own));
    const before = await call(
      getHealthClusters as Handler,
      { orgId: own.orgId },
      cookie,
    ).then((r) => r.json());
    expect(before.items[0]).toMatchObject({
      name: "CH-01",
      last_seen: null,
      sd_free_mb: null,
    });
    const res = await clusterHealth(
      new Request("http://test/x", {
        method: "POST",
        headers: { authorization: `Bearer ${own.apiKey}` },
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          uptime_s: 100,
          sd_free_mb: 5000,
          uplink_type: "4g",
          buffered_count: 2,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const after = await call(
      getHealthClusters as Handler,
      { orgId: own.orgId },
      cookie,
    ).then((r) => r.json());
    expect(after.items[0]).toMatchObject({
      sd_free_mb: 5000,
      uplink_type: "4g",
      buffered_count: 2,
      uptime_s: 100,
    });
  });
});

describe("health ingest", () => {
  const send = (
    handler: typeof nodeHealth,
    key: string | null,
    payload: unknown,
  ) =>
    handler(
      new Request("http://test/x", {
        method: "POST",
        headers: key ? { authorization: `Bearer ${key}` } : {},
        body: JSON.stringify(payload),
      }),
    );
  const now = () => new Date(Date.now() - 100).toISOString();

  it("node health: stores, repeats are 200, every error row behaves", async () => {
    const own = await makeOrg([100]);
    const payload = { node_id: 100, timestamp: now(), battery_mv: 3800 };
    expect((await send(nodeHealth, own.apiKey, payload)).status).toBe(201);
    expect((await send(nodeHealth, own.apiKey, payload)).status).toBe(200);
    expect((await send(nodeHealth, null, payload)).status).toBe(401);
    expect(
      (await send(nodeHealth, own.apiKey, { ...payload, node_id: 99 })).status,
    ).toBe(422);
    expect(
      (await send(nodeHealth, own.apiKey, { ...payload, battery_mv: -1 }))
        .status,
    ).toBe(400);
    expect((await send(nodeHealth, own.apiKey, { node_id: 100 })).status).toBe(
      400,
    );
  });

  it("node health under the same LoRa ID goes to the key's organization", async () => {
    const x = await makeOrg([100]);
    const y = await makeOrg([100]);
    await send(nodeHealth, x.apiKey, {
      node_id: 100,
      timestamp: now(),
      battery_mv: 3111,
    });
    const rows = await ownerQuery<{ org_id: string }>(
      "SELECT org_id FROM node_health WHERE battery_mv = 3111 AND org_id = ANY($1::uuid[])",
      [[x.orgId, y.orgId]],
    );
    expect(rows).toEqual([{ org_id: x.orgId }]);
  });

  it("cluster health: stores, repeats are 200, bad values are 400", async () => {
    const own = await makeOrg([100]);
    const payload = { timestamp: now(), sd_free_mb: 100 };
    expect((await send(clusterHealth, own.apiKey, payload)).status).toBe(201);
    expect((await send(clusterHealth, own.apiKey, payload)).status).toBe(200);
    expect(
      (
        await send(clusterHealth, own.apiKey, {
          ...payload,
          uplink_type: "pigeon",
        })
      ).status,
    ).toBe(400);
    expect((await send(clusterHealth, "bad", payload)).status).toBe(401);
  });
});

describe("CSV export", () => {
  async function exported(file: string, org = a, cookie = cookieA, query = "") {
    const res = await call(
      getExport as Handler,
      { orgId: org.orgId, file },
      cookie,
      `http://test/x${query}`,
    );
    expect(res.status).toBe(200);
    return { res, rows: parseCsv(await res.text()) };
  }

  it.each([
    ["features.csv", "tree_label", 2],
    ["classifications.csv", "confidence", 2],
    ["alerts.csv", "severity", 2],
  ])(
    "%s has a header and this organization's rows",
    async (file, column, count) => {
      const { res, rows } = await exported(file);
      expect(res.headers.get("content-type")).toContain("text/csv");
      expect(res.headers.get("content-disposition")).toContain(
        `${a.slug}-${file}`,
      );
      expect(rows[0]).toContain(column);
      expect(rows).toHaveLength(count + 1);
    },
  );

  it("404 for any other file name", async () => {
    for (const file of ["users.csv", "constructor", "__proto__"]) {
      expect(
        (await call(getExport as Handler, { orgId: a.orgId, file }, cookieA))
          .status,
      ).toBe(404);
    }
  });

  it("neutralizes a formula in a tree label", async () => {
    const own = await makeOrg([100]);
    const cookie = await cookieFor(ownerEmail(own));
    await ownerQuery(
      "UPDATE nodes SET tree_label = '=HYPERLINK(\"http://evil\")' WHERE org_id = $1",
      [own.orgId],
    );
    await classified(own, 100, 0.1, 5);
    const { rows } = await exported("features.csv", own, cookie);
    expect(rows[1]![2]).toBe('\'=HYPERLINK("http://evil")');
  });

  it("quotes commas, quotes and line breaks, and round-trips", () => {
    const text = csvRow([
      "a,b",
      'say "hi"',
      "two\nlines",
      null,
      5,
      new Date(0),
    ]);
    expect(parseCsv(text)).toEqual([
      ["a,b", 'say "hi"', "two\nlines", "", "5", "1970-01-01T00:00:00.000Z"],
    ]);
  });
});

describe("organization settings", () => {
  async function fresh() {
    const own = await makeOrg([100]);
    return { own, cookie: await cookieFor(ownerEmail(own)) };
  }

  it("saves, and the new thresholds change tree status at once", async () => {
    const { own, cookie } = await fresh();
    await classified(own, 100, 0.6, 5);
    const params = { orgId: own.orgId };
    expect(
      (
        await call(
          getTree as Handler,
          { ...params, nodeId: await firstNode(own) },
          cookie,
        ).then((r) => r.json())
      ).status,
    ).toBe("suspected");
    const res = await write(
      patchOrg as Handler,
      params,
      cookie,
      {
        name: "New name",
        timezone: "UTC",
        suspect_threshold: 0.2,
        alert_threshold: 0.5,
      },
      { method: "PATCH" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: "New name",
      timezone: "UTC",
      suspect_threshold: 0.2,
      alert_threshold: 0.5,
    });
    expect(
      (
        await call(
          getTree as Handler,
          { ...params, nodeId: await firstNode(own) },
          cookie,
        ).then((r) => r.json())
      ).status,
    ).toBe("alert");
  });

  it.each([
    [{ timezone: "Mars/Olympus" }],
    [{ suspect_threshold: 0.9, alert_threshold: 0.5 }],
    [{ suspect_threshold: 0.8 }], // equal to the current alert threshold
    [{ alert_threshold: 1.5 }],
    [{ name: "" }],
  ])("refuses %j", async (body) => {
    const { own, cookie } = await fresh();
    const res = await write(
      patchOrg as Handler,
      { orgId: own.orgId },
      cookie,
      body,
      { method: "PATCH" },
    );
    expect(res.status).toBe(400);
  });

  it("ignores attempts to change the slug or org_id", async () => {
    const { own, cookie } = await fresh();
    await write(
      patchOrg as Handler,
      { orgId: own.orgId },
      cookie,
      { slug: "stolen", org_id: a.orgId },
      { method: "PATCH" },
    );
    const [row] = await ownerQuery<{ slug: string }>(
      "SELECT slug FROM organizations WHERE org_id = $1",
      [own.orgId],
    );
    expect(row!.slug).toBe(own.slug);
  });
});

describe("members and invites", () => {
  async function invite(org: TestOrg, cookie: string, email: string) {
    const res = await write(
      postInvite as Handler,
      { orgId: org.orgId },
      cookie,
      { email },
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    return { ...json, token: json.link.split("/invite/")[1] as string };
  }
  const accept = (
    token: string,
    cookie: string | undefined,
    body: unknown,
    origin: string | null = ORIGIN,
  ) =>
    acceptInvite(
      new Request("http://test/x", {
        method: "POST",
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ token }) },
    );

  it("the last owner can't be removed", async () => {
    const own = await makeOrg([100]);
    const cookie = await cookieFor(ownerEmail(own));
    const members = await call(
      getMembers as Handler,
      { orgId: own.orgId },
      cookie,
    ).then((r) => r.json());
    expect(members.items).toHaveLength(1);
    expect(JSON.stringify(members)).not.toContain("argon2");
    const res = await write(
      deleteMember as Handler,
      { orgId: own.orgId, userId: members.you },
      cookie,
      undefined,
      { method: "DELETE" },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("last_owner");
  });

  it("a new person joins with a single-use link, and only the hash is stored", async () => {
    const own = await makeOrg([100]);
    const cookie = await cookieFor(ownerEmail(own));
    const email = `new-${own.slug}@test.example`;
    const { token } = await invite(own, cookie, email.toUpperCase());

    const [stored] = await ownerQuery<{ token_hash: string; email: string }>(
      "SELECT token_hash, email FROM organization_invites WHERE org_id = $1",
      [own.orgId],
    );
    expect(stored!.token_hash).not.toContain(token);
    expect(stored!.email).toBe(email);

    const lookup = await getInvite(new Request("http://test/x"), {
      params: Promise.resolve({ token }),
    });
    expect(await lookup.json()).toEqual({
      org_name: own.slug,
      email,
      account_exists: false,
    });

    expect(
      (await accept(token, undefined, { name: "New", password: "short" }))
        .status,
    ).toBe(400);
    expect(
      (
        await accept(
          token,
          undefined,
          { name: "New", password: "long-enough-password" },
          null,
        )
      ).status,
    ).toBe(403);

    const res = await accept(token, undefined, {
      name: "New Person",
      password: "long-enough-password",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toContain("nakhel_session=");

    const newCookie = await cookieFor(email, "long-enough-password");
    expect(
      (await call(getMembers as Handler, { orgId: own.orgId }, newCookie))
        .status,
    ).toBe(200);

    expect(
      (
        await accept(token, undefined, {
          name: "Again",
          password: "long-enough-password",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await getInvite(new Request("http://test/x"), {
          params: Promise.resolve({ token }),
        })
      ).status,
    ).toBe(404);
    // The new member doesn't reach anyone else's organization.
    expect(
      (await call(getMembers as Handler, { orgId: a.orgId }, newCookie)).status,
    ).toBe(404);
  });

  it("the token alone never grants access to an existing account", async () => {
    const own = await makeOrg([100]);
    const cookie = await cookieFor(ownerEmail(own));
    const existing = await makeOrg([100]);
    const email = ownerEmail(existing);
    const { token } = await invite(own, cookie, email);

    const lookup = await getInvite(new Request("http://test/x"), {
      params: Promise.resolve({ token }),
    });
    expect((await lookup.json()).account_exists).toBe(true);

    const anonymous = await accept(token, undefined, {
      name: "x",
      password: "attacker-password",
    });
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.code).toBe("login_required");

    const wrong = await accept(token, cookie, {});
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error.code).toBe("wrong_account");

    const right = await accept(token, await cookieFor(email), {});
    expect(right.status).toBe(200);
    expect(
      (
        await call(
          getMembers as Handler,
          { orgId: own.orgId },
          await cookieFor(email),
        )
      ).status,
    ).toBe(200);
    // Their password didn't change.
    await cookieFor(email, "test-password");
  });

  it("expired invites don't work; existing members can't be invited; a new invite replaces the old", async () => {
    const own = await makeOrg([100]);
    const cookie = await cookieFor(ownerEmail(own));
    const first = await invite(own, cookie, `twice-${own.slug}@test.example`);
    const second = await invite(own, cookie, `twice-${own.slug}@test.example`);
    expect(
      (
        await accept(first.token, undefined, {
          name: "A",
          password: "long-enough-password",
        })
      ).status,
    ).toBe(404);
    const open = await call(
      getInvites as Handler,
      { orgId: own.orgId },
      cookie,
    ).then((r) => r.json());
    expect(open.items).toHaveLength(1);

    await ownerQuery(
      "UPDATE organization_invites SET expires_at = now() - INTERVAL '1 second' WHERE org_id = $1",
      [own.orgId],
    );
    expect(
      (
        await accept(second.token, undefined, {
          name: "A",
          password: "long-enough-password",
        })
      ).status,
    ).toBe(404);

    const member = await write(
      postInvite as Handler,
      { orgId: own.orgId },
      cookie,
      { email: ownerEmail(own) },
    );
    expect(member.status).toBe(409);
    expect(
      (
        await write(postInvite as Handler, { orgId: own.orgId }, cookie, {
          email: "nope",
        })
      ).status,
    ).toBe(400);
  });

  it("an owner can cancel an invite", async () => {
    const own = await makeOrg([100]);
    const cookie = await cookieFor(ownerEmail(own));
    const { token, invite_id: inviteId } = await invite(
      own,
      cookie,
      `cancel-${own.slug}@test.example`,
    );
    const res = await write(
      deleteInvite as Handler,
      { orgId: own.orgId, inviteId },
      cookie,
      undefined,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);
    expect(
      (
        await accept(token, undefined, {
          name: "A",
          password: "long-enough-password",
        })
      ).status,
    ).toBe(404);
  });

  it("a second owner can be removed, and loses access at once", async () => {
    const own = await makeOrg([100]);
    const cookie = await cookieFor(ownerEmail(own));
    const email = `second-${own.slug}@test.example`;
    const { token } = await invite(own, cookie, email);
    await accept(token, undefined, {
      name: "Second",
      password: "long-enough-password",
    });
    const secondCookie = await cookieFor(email, "long-enough-password");
    const [row] = await ownerQuery<{ user_id: string }>(
      "SELECT user_id FROM users WHERE email = $1",
      [email],
    );
    const res = await write(
      deleteMember as Handler,
      { orgId: own.orgId, userId: row!.user_id },
      cookie,
      undefined,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);
    expect(
      (await call(getMembers as Handler, { orgId: own.orgId }, secondCookie))
        .status,
    ).toBe(404);
  });
});

describe("cluster heads", () => {
  const send = (key: string) =>
    ingest(
      new Request("http://test/x", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify(measurement({ node_id: 200 })),
      }),
    );

  it("registering shows a working key once; only a hash is listed", async () => {
    const own = await makeOrg([100]);
    const cookie = await cookieFor(ownerEmail(own));
    const res = await write(
      postCluster as Handler,
      { orgId: own.orgId },
      cookie,
      {
        name: "CH-NEW",
        farm_zone: "Zone Q",
        uplink_type: "4g",
        location_lat: 24.2,
        location_lon: 55.7,
      },
    );
    expect(res.status).toBe(201);
    const { api_key: key, cluster_id: clusterId } = await res.json();
    expect(key).toMatch(/^nkh_/);
    const list = await call(
      getClusters as Handler,
      { orgId: own.orgId },
      cookie,
    ).then((r) => r.json());
    expect(JSON.stringify(list)).not.toContain(key);
    expect(JSON.stringify(list)).not.toContain("api_key_hash");
    const node = await write(
      postNode as Handler,
      { orgId: own.orgId },
      cookie,
      { lora_id: 200, tree_label: "New", cluster_id: clusterId },
    );
    expect(node.status).toBe(201);
    expect((await send(key)).status).toBe(201);
  });

  it("a duplicate name is 409; a bad uplink is 400", async () => {
    const own = await makeOrg([100]);
    const cookie = await cookieFor(ownerEmail(own));
    const duplicate = await write(
      postCluster as Handler,
      { orgId: own.orgId },
      cookie,
      { name: "CH-01" },
    );
    expect(duplicate.status).toBe(409);
    expect(
      (
        await write(postCluster as Handler, { orgId: own.orgId }, cookie, {
          name: "X",
          uplink_type: "pigeon",
        })
      ).status,
    ).toBe(400);
  });

  it("rotating kills the old key at once; revoking kills it too; rotating brings it back", async () => {
    const own = await makeOrg([200]);
    const cookie = await cookieFor(ownerEmail(own));
    const params = { orgId: own.orgId, clusterId: own.clusterId };
    expect((await send(own.apiKey)).status).toBe(201);
    const { api_key: rotated } = await write(
      rotateKey as Handler,
      params,
      cookie,
    ).then((r) => r.json());
    expect((await send(own.apiKey)).status).toBe(401);
    expect((await send(rotated)).status).toBe(201);
    expect((await write(revokeKey as Handler, params, cookie)).status).toBe(
      200,
    );
    expect((await send(rotated)).status).toBe(401);
    const { api_key: revived } = await write(
      rotateKey as Handler,
      params,
      cookie,
    ).then((r) => r.json());
    expect((await send(revived)).status).toBe(201);
  });
});

describe("nodes", () => {
  async function fresh() {
    const own = await makeOrg([100]);
    return { own, cookie: await cookieFor(ownerEmail(own)) };
  }

  it("lists, searches and adds", async () => {
    const { own, cookie } = await fresh();
    const res = await write(postNode as Handler, { orgId: own.orgId }, cookie, {
      lora_id: 150,
      tree_label: "Palm X",
      cluster_id: own.clusterId,
      farm_zone: "Zone A",
      location_lat: 24.2,
      location_lon: 55.7,
    });
    expect(res.status).toBe(201);
    const list = await call(
      getNodes as Handler,
      { orgId: own.orgId },
      cookie,
    ).then((r) => r.json());
    expect(list.total).toBe(2);
    const found = await call(
      getNodes as Handler,
      { orgId: own.orgId },
      cookie,
      "http://test/x?q=Palm",
    ).then((r) => r.json());
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({
      lora_id: 150,
      cluster_name: "CH-01",
      active: true,
    });
  });

  it.each([
    [{ lora_id: 70000, tree_label: "x" }, 400],
    [{ lora_id: -1, tree_label: "x" }, 400],
    [{ lora_id: 1, tree_label: "" }, 400],
    [{ lora_id: 1, tree_label: "x", location_lat: 91 }, 400],
    [{ lora_id: 100, tree_label: "duplicate LoRa" }, 409],
  ])("refuses %j", async (body, status) => {
    const { own, cookie } = await fresh();
    const res = await write(postNode as Handler, { orgId: own.orgId }, cookie, {
      cluster_id: own.clusterId,
      ...body,
    });
    expect(res.status).toBe(status);
  });

  it("edits only what's sent, and can clear coordinates", async () => {
    const { own, cookie } = await fresh();
    const nodeId = await firstNode(own);
    const params = { orgId: own.orgId, nodeId };
    const first = await write(
      patchNode as Handler,
      params,
      cookie,
      { tree_label: "Renamed", location_lat: 24.5, location_lon: 55.5 },
      { method: "PATCH" },
    );
    expect(await first.json()).toMatchObject({
      tree_label: "Renamed",
      lora_id: 100,
      location_lat: 24.5,
    });
    const second = await write(
      patchNode as Handler,
      params,
      cookie,
      { location_lat: null, location_lon: null },
      { method: "PATCH" },
    );
    expect(await second.json()).toMatchObject({
      tree_label: "Renamed",
      location_lat: null,
    });
  });

  it("a retired node's LoRa ID stops working and can be reused", async () => {
    const { own, cookie } = await fresh();
    const params = { orgId: own.orgId, nodeId: await firstNode(own) };
    expect(
      (
        await write(
          patchNode as Handler,
          params,
          cookie,
          { active: false },
          { method: "PATCH" },
        )
      ).status,
    ).toBe(200);
    const list = await call(
      getHealthNodes as Handler,
      { orgId: own.orgId },
      cookie,
    ).then((r) => r.json());
    expect(list.items).toEqual([]);
    const reuse = await write(
      postNode as Handler,
      { orgId: own.orgId },
      cookie,
      { lora_id: 100, tree_label: "Replacement", cluster_id: own.clusterId },
    );
    expect(reuse.status).toBe(201);
    const restore = await write(
      patchNode as Handler,
      params,
      cookie,
      { active: true },
      { method: "PATCH" },
    );
    expect(restore.status).toBe(409);
  });

  describe("CSV import", () => {
    const header =
      "lora_id,tree_label,cluster,farm_zone,location_lat,location_lon\n";

    it("imports, with quotes and blank optional columns", async () => {
      const { own, cookie } = await fresh();
      const csv = `${header}200,"Palm, North",CH-01,Zone A,24.2,55.7\n201,Palm 2,CH-01,,,\n`;
      const res = await write(
        importNodes as Handler,
        { orgId: own.orgId },
        cookie,
        { csv },
      );
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ imported: 2 });
      const found = await call(
        getNodes as Handler,
        { orgId: own.orgId },
        cookie,
        "http://test/x?q=North",
      ).then((r) => r.json());
      expect(found.items[0]).toMatchObject({
        tree_label: "Palm, North",
        lora_id: 200,
        location_lat: 24.2,
      });
    });

    it.each([
      ["a bad LoRa ID", `${header}200,Good,CH-01\n70000,Bad,CH-01\n`, 3],
      [
        "an unknown cluster head",
        `${header}200,Good,CH-01\n201,Bad,CH-99\n`,
        3,
      ],
      [
        "a LoRa ID already in use",
        `${header}200,Good,CH-01\n100,Bad,CH-01\n`,
        3,
      ],
      [
        "a repeat within the file",
        `${header}200,Good,CH-01\n200,Bad,CH-01\n`,
        3,
      ],
    ])(
      "all or nothing: %s imports none and names the line",
      async (_name, csv, line) => {
        const { own, cookie } = await fresh();
        const res = await write(
          importNodes as Handler,
          { orgId: own.orgId },
          cookie,
          { csv },
        );
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error.details[0].line).toBe(line);
        const list = await call(
          getNodes as Handler,
          { orgId: own.orgId },
          cookie,
        ).then((r) => r.json());
        expect(list.total).toBe(1);
      },
    );

    it("refuses missing columns and empty files", async () => {
      const { own, cookie } = await fresh();
      expect(
        (
          await write(importNodes as Handler, { orgId: own.orgId }, cookie, {
            csv: "lora_id,tree_label\n1,x",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await write(importNodes as Handler, { orgId: own.orgId }, cookie, {
            csv: header,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await write(importNodes as Handler, { orgId: own.orgId }, cookie, {
            csv: "",
          })
        ).status,
      ).toBe(400);
    });

    it("can't reach another organization's cluster head", async () => {
      const { own, cookie } = await fresh();
      const other = await makeOrg([100]);
      await ownerQuery(
        "UPDATE cluster_heads SET name = 'THEIRS' WHERE cluster_id = $1",
        [other.clusterId],
      );
      const res = await write(
        importNodes as Handler,
        { orgId: own.orgId },
        cookie,
        { csv: `${header}5,x,THEIRS\n` },
      );
      expect(res.status).toBe(400);
    });
  });
});

describe("pipeline latency", () => {
  it("reports for the organization", async () => {
    const json = await call(
      getLatency as Handler,
      { orgId: a.orgId },
      cookieA,
    ).then((r) => r.json());
    expect(json.classified).toBe(2);
    expect(json).toHaveProperty("classify_p50_ms");
    expect(json.alerts).toBe(0);
  });
});
