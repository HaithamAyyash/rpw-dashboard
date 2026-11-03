import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/v1/auth/login/route";
import { POST as logout } from "@/app/api/v1/auth/logout/route";
import { GET as me } from "@/app/api/v1/auth/me/route";
import { GET as getOrg } from "@/app/api/v1/orgs/[orgId]/route";
import { GET as getSummary } from "@/app/api/v1/orgs/[orgId]/summary/route";
import { GET as getTrees } from "@/app/api/v1/orgs/[orgId]/trees/route";
import { GET as getZones } from "@/app/api/v1/orgs/[orgId]/zones/route";
import { registerCluster } from "@/lib/admin";
import { signSession } from "@/lib/auth/session";
import { pool } from "@/lib/db/pool";
import { generatedQueries } from "@/scripts/gen-queries";
import { makeOrg, ownerQuery, type TestOrg } from "./helpers";

const ORIGIN = (process.env.APP_ORIGIN ?? "").split(",")[0]!.trim();
const BASE = "http://test/api/v1";

function loginRequest(
  email: string,
  password: string,
  origin: string | null = ORIGIN,
) {
  return login(
    new Request(`${BASE}/auth/login`, {
      method: "POST",
      headers: origin ? { origin } : {},
      body: JSON.stringify({ email, password }),
    }),
  );
}

async function cookieFor(org: TestOrg): Promise<string> {
  const res = await loginRequest(`${org.slug}@test.example`, "test-password");
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

function get(url: string, cookie?: string) {
  return new Request(`${BASE}${url}`, { headers: cookie ? { cookie } : {} });
}

const ctx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });

async function addRuns(org: TestOrg, loraId: number, confidences: number[]) {
  const [node] = await ownerQuery<{ node_id: string }>(
    "SELECT node_id FROM nodes WHERE org_id = $1 AND lora_id = $2",
    [org.orgId, loraId],
  );
  for (const [i, confidence] of confidences.entries()) {
    await ownerQuery(
      `INSERT INTO classification_results ("timestamp", org_id, node_id, label, confidence, model_version)
       VALUES (now() - make_interval(mins => $1::int), $2, $3, 'healthy', $4, 't')`,
      [i + 1, org.orgId, node!.node_id, confidence],
    );
  }
}

let a: TestOrg;
let b: TestOrg;
let cookieA: string;
let cookieB: string;

beforeAll(async () => {
  a = await makeOrg([100, 101, 102]);
  b = await makeOrg([100, 101]);
  await registerCluster({
    orgSlug: a.slug,
    name: "CH-02",
    farmZone: "Zone Z",
    loraIds: [50],
  });
  await addRuns(a, 100, [0.1, 0.1, 0.1]);
  await addRuns(a, 101, [0.6, 0.6, 0.6]);
  await addRuns(a, 102, [0.9, 0.9, 0.9]);
  cookieA = await cookieFor(a);
  cookieB = await cookieFor(b);
});

describe("login", () => {
  it("sets an httpOnly, SameSite session cookie and records the login", async () => {
    const res = await loginRequest(`${a.slug}@test.example`, "test-password");
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^nakhel_session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const [row] = await ownerQuery<{ last_login: Date | null }>(
      "SELECT last_login FROM users WHERE email = $1",
      [`${a.slug}@test.example`],
    );
    expect(row?.last_login).not.toBeNull();
  });

  it("accepts the email in any case", async () => {
    const res = await loginRequest(
      `${a.slug}@TEST.example`.toUpperCase(),
      "test-password",
    );
    expect(res.status).toBe(200);
  });

  it.each([
    ["wrong password", (o: TestOrg) => `${o.slug}@test.example`, "nope"],
    ["unknown email", () => "nobody@test.example", "test-password"],
  ])("gives the same answer for %s", async (_name, email, password) => {
    const res = await loginRequest(email(a), password);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_credentials");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a bad body", async () => {
    const res = await login(
      new Request(`${BASE}/auth/login`, {
        method: "POST",
        headers: { origin: ORIGIN },
        body: "{",
      }),
    );
    expect(res.status).toBe(400);
  });

  it.each([
    ["missing origin", null],
    ["another site", "https://evil.example"],
  ])("refuses %s (CSRF)", async (_name, origin) => {
    const res = await loginRequest(
      `${a.slug}@test.example`,
      "test-password",
      origin,
    );
    expect(res.status).toBe(403);
  });

  it("logout clears the cookie and needs a valid origin", async () => {
    const bad = await logout(
      new Request(`${BASE}/auth/logout`, { method: "POST" }),
    );
    expect(bad.status).toBe(403);
    const res = await logout(
      new Request(`${BASE}/auth/logout`, {
        method: "POST",
        headers: { origin: ORIGIN },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("origin check", () => {
  const attempt = (headers: Record<string, string>) =>
    login(
      new Request(`${BASE}/auth/login`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: "nobody@test.example", password: "x" }),
      }),
    ).then((r) => r.status);

  it("in development, allows any port or tunnel the request really arrived on", async () => {
    expect(
      await attempt({
        origin: "http://localhost:3101",
        host: "localhost:3101",
      }),
    ).toBe(401);
    expect(
      await attempt({
        origin: "https://abc.devtunnels.ms",
        "x-forwarded-host": "abc.devtunnels.ms",
      }),
    ).toBe(401);
  });

  it("in development, still refuses another site", async () => {
    expect(
      await attempt({ origin: "https://evil.example", host: "localhost:3100" }),
    ).toBe(403);
    expect(await attempt({ origin: "not a url", host: "localhost:3100" })).toBe(
      403,
    );
    expect(await attempt({ host: "localhost:3100" })).toBe(403);
  });

  it("in production, allows only APP_ORIGIN, whatever the request says", async () => {
    const saved = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = "https://nakhel.example.com";
    try {
      expect(
        await attempt({
          origin: "https://nakhel.example.com",
          host: "nakhel.example.com",
        }),
      ).toBe(401);
      expect(
        await attempt({ origin: "https://evil.example", host: "evil.example" }),
      ).toBe(403);
      expect(
        await attempt({
          origin: "http://localhost:3101",
          host: "localhost:3101",
        }),
      ).toBe(403);
    } finally {
      process.env.APP_ORIGIN = saved;
    }
  });
});

describe("sessions", () => {
  it("/auth/me returns the user and their organizations", async () => {
    const res = await me(get("/auth/me", cookieA));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.email).toBe(`${a.slug}@test.example`);
    expect(json.organizations.map((o: { org_id: string }) => o.org_id)).toEqual(
      [a.orgId],
    );
    expect(JSON.stringify(json)).not.toContain("argon2");
  });

  it.each([
    ["no cookie", undefined],
    ["garbage", "nakhel_session=garbage"],
    [
      "a token signed with another secret",
      "nakhel_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.AAAA",
    ],
  ])("401 with %s", async (_name, cookie) => {
    expect((await me(get("/auth/me", cookie))).status).toBe(401);
  });

  it("raising token_version ends existing sessions", async () => {
    const own = await makeOrg();
    const cookie = await cookieFor(own);
    expect((await me(get("/auth/me", cookie))).status).toBe(200);
    await ownerQuery(
      "UPDATE users SET token_version = token_version + 1 WHERE email = $1",
      [`${own.slug}@test.example`],
    );
    expect((await me(get("/auth/me", cookie))).status).toBe(401);
  });

  it("re-issues the cookie only once a session is over 6 hours old", async () => {
    const fresh = await me(get("/auth/me", cookieA));
    expect(fresh.headers.get("set-cookie")).toBeNull();

    const [user] = await ownerQuery<{ user_id: string }>(
      "SELECT user_id FROM users WHERE email = $1",
      [`${a.slug}@test.example`],
    );
    const { SignJWT } = await import("jose");
    const old = await new SignJWT({ tv: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user!.user_id)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7 * 3600)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
    const res = await me(get("/auth/me", `nakhel_session=${old}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^nakhel_session=/);
  });

  it("a valid token for a user who doesn't exist gets 401", async () => {
    const token = await signSession("00000000-0000-4000-8000-000000000000", 0);
    expect((await me(get("/auth/me", `nakhel_session=${token}`))).status).toBe(
      401,
    );
  });
});

const orgEndpoints: [
  string,
  (orgId: string, cookie?: string) => Promise<Response>,
][] = [
  ["GET /orgs/{id}", (id, c) => getOrg(get(`/orgs/${id}`, c), ctx(id))],
  [
    "GET /summary",
    (id, c) => getSummary(get(`/orgs/${id}/summary`, c), ctx(id)),
  ],
  ["GET /trees", (id, c) => getTrees(get(`/orgs/${id}/trees`, c), ctx(id))],
  ["GET /zones", (id, c) => getZones(get(`/orgs/${id}/zones`, c), ctx(id))],
];

describe.each(orgEndpoints)("%s access", (_name, call) => {
  it("answers members", async () => {
    expect((await call(a.orgId, cookieA)).status).toBe(200);
  });
  it("401 when not logged in", async () => {
    expect((await call(a.orgId)).status).toBe(401);
  });
  it("404, never 403, for another organization", async () => {
    const res = await call(b.orgId, cookieA);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
  it("gives the same 404 for an organization that doesn't exist", async () => {
    expect(
      (await call("00000000-0000-4000-8000-000000000000", cookieA)).status,
    ).toBe(404);
  });
  it("404 for an ID that isn't a UUID", async () => {
    expect((await call("not-a-uuid", cookieA)).status).toBe(404);
  });
});

describe("GET /orgs/{id}", () => {
  it("returns thresholds as numbers", async () => {
    const res = await getOrg(get(`/orgs/${a.orgId}`, cookieA), ctx(a.orgId));
    expect(await res.json()).toMatchObject({
      org_id: a.orgId,
      slug: a.slug,
      timezone: "Asia/Dubai",
      suspect_threshold: 0.5,
      alert_threshold: 0.8,
    });
  });
});

describe("GET /summary", () => {
  it("counts by status, with no health data", async () => {
    const res = await getSummary(
      get(`/orgs/${a.orgId}/summary`, cookieA),
      ctx(a.orgId),
    );
    expect(await res.json()).toMatchObject({
      trees_monitored: 4,
      healthy: 1,
      suspected: 1,
      alerts: 1,
      offline: 0,
      unknown: 1,
      total_nodes: 4,
      with_heartbeat: 0,
    });
  });

  it("filters by zone", async () => {
    const url = `/orgs/${a.orgId}/summary?zone=${encodeURIComponent("Zone Z")}`;
    const res = await getSummary(get(url, cookieA), ctx(a.orgId));
    expect(await res.json()).toMatchObject({
      trees_monitored: 1,
      unknown: 1,
      suspected: 0,
    });
  });

  it("reports the change since yesterday", async () => {
    const own = await makeOrg([100]);
    const cookie = await cookieFor(own);
    await addRuns(own, 100, [0.6, 0.6, 0.6]); // all recent, so yesterday it wasn't suspected
    const res = await getSummary(
      get(`/orgs/${own.orgId}/summary`, cookie),
      ctx(own.orgId),
    );
    expect(await res.json()).toMatchObject({
      suspected: 1,
      suspected_yesterday: 0,
      suspected_change: 1,
    });
  });
});

describe("GET /trees", () => {
  async function trees(query: string, org = a, cookie = cookieA) {
    const res = await getTrees(
      get(`/orgs/${org.orgId}/trees${query}`, cookie),
      ctx(org.orgId),
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  it("returns card data with numeric fields", async () => {
    const json = await trees("?status=alert");
    expect(json.total).toBe(1);
    expect(json.items[0]).toMatchObject({
      lora_id: 102,
      status: "alert",
      avg_confidence: 0.9,
      measurements_24h: 0,
      last_measurement: null,
      battery_mv: null,
    });
    expect(typeof json.items[0].node_id).toBe("number");
    expect(json.items[0].last_runs).toHaveLength(3);
    expect(json.items[0]).not.toHaveProperty("total_count");
  });

  it("filters by zone, and searches label and LoRa ID", async () => {
    expect((await trees(`?zone=${encodeURIComponent("Zone Z")}`)).total).toBe(
      1,
    );
    expect((await trees("?q=50")).total).toBe(1);
    expect((await trees("?q=CH-02")).total).toBe(1);
    expect((await trees("?q=nothing-like-this")).items).toEqual([]);
  });

  it("paginates", async () => {
    const first = await trees("?page_size=2&page=1");
    const second = await trees("?page_size=2&page=2");
    expect(first.total).toBe(4);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    const ids = [...first.items, ...second.items].map(
      (t: { node_id: number }) => t.node_id,
    );
    expect(new Set(ids).size).toBe(4);
  });

  it.each(["?status=bogus", "?page=0", "?page_size=201", "?page=abc"])(
    "400 for %s",
    async (query) => {
      const res = await getTrees(
        get(`/orgs/${a.orgId}/trees${query}`, cookieA),
        ctx(a.orgId),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_query");
    },
  );

  it("the same LoRa ID shows each organization only its own node", async () => {
    const ofA = await trees("?q=100", a, cookieA);
    const ofB = await trees("?q=100", b, cookieB);
    expect(ofA.total).toBe(1);
    expect(ofB.total).toBe(1);
    expect(ofA.items[0].node_id).not.toBe(ofB.items[0].node_id);
  });
});

describe("GET /zones", () => {
  it("lists this organization's zones", async () => {
    const res = await getZones(
      get(`/orgs/${a.orgId}/zones`, cookieA),
      ctx(a.orgId),
    );
    expect(await res.json()).toEqual({
      items: [{ farm_zone: "Zone Z", trees: 1 }],
    });
  });
});

describe("a user in several organizations", () => {
  it("can reach both, and leaving one closes it immediately", async () => {
    const x = await makeOrg([100]);
    const y = await makeOrg([100]);
    const [user] = await ownerQuery<{ user_id: string }>(
      "SELECT user_id FROM users WHERE email = $1",
      [`${x.slug}@test.example`],
    );
    await ownerQuery(
      "INSERT INTO organization_members (org_id, user_id) VALUES ($1, $2)",
      [y.orgId, user!.user_id],
    );
    const cookie = await cookieFor(x);
    expect(
      (await getOrg(get(`/orgs/${y.orgId}`, cookie), ctx(y.orgId))).status,
    ).toBe(200);
    await ownerQuery(
      "DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2",
      [y.orgId, user!.user_id],
    );
    expect(
      (await getOrg(get(`/orgs/${y.orgId}`, cookie), ctx(y.orgId))).status,
    ).toBe(404);
  });
});

describe("generated files", () => {
  it("lib/db/queries.generated.ts matches db/queries", () => {
    const file = path.resolve(__dirname, "../lib/db/queries.generated.ts");
    expect(readFileSync(file, "utf8")).toBe(generatedQueries());
  });

  it("leaves no organization set on pooled connections", async () => {
    const { rows } = await pool().query<{ count: string }>(
      "SELECT count(*) FROM nodes",
    );
    expect(rows[0]?.count).toBe("0");
  });
});
