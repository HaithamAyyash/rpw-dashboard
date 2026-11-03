import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "@/lib/db/pool";
import { withOrg } from "@/lib/db/withOrg";
import type {
  ClusterHealth,
  Measurement,
  NodeHealth,
} from "@/lib/schemas/ingest";

export type ClusterIdentity = { clusterId: string; orgId: string };

const EXCERPT_CHARS = 2048;
const STORED_BODY_MAX_CHARS = 65536;

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** API key -> cluster head and organization. Revoked keys don't match. */
export async function authenticateKey(
  key: string,
): Promise<ClusterIdentity | null> {
  const { rows } = await pool().query<{ cluster_id: string; org_id: string }>(
    "SELECT cluster_id, org_id FROM ingest_auth($1)",
    [hashApiKey(key)],
  );
  const row = rows[0];
  return row ? { clusterId: row.cluster_id, orgId: row.org_id } : null;
}

/**
 * Rounds to what a Postgres `real` stores. Without this, a value too small for `real` (1e-300,
 * which is valid JSON) would make the insert fail, and the Pi would retry it forever.
 */
function toRealMatrix(mfcc: number[][]): number[][] {
  return mfcc.map((row) => row.map((value) => Math.fround(value)));
}

async function findNodeId(
  client: PoolClient,
  clusterId: string,
  loraId: number,
): Promise<string | null> {
  const { rows } = await client.query<{ node_id: string }>(
    "SELECT node_id FROM nodes WHERE cluster_id = $1 AND lora_id = $2 AND active",
    [clusterId, loraId],
  );
  return rows[0]?.node_id ?? null;
}

export type StoreResult = "stored" | "duplicate" | "unknown_node";

export async function storeMeasurement(
  identity: ClusterIdentity,
  m: Measurement,
): Promise<StoreResult> {
  return withOrg(identity.orgId, async (client) => {
    const nodeId = await findNodeId(client, identity.clusterId, m.node_id);
    if (nodeId === null) return "unknown_node";

    const { rowCount } = await client.query(
      `INSERT INTO acoustic_features
         ("timestamp", org_id, node_id, cluster_id, mfcc, confidence, model_version, snr_db, rssi_dbm, msg_id, received_at, schema_version)
       VALUES ($1, $2, $3, $4, $5::real[], $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (node_id, "timestamp") DO NOTHING`,
      [
        m.timestamp,
        identity.orgId,
        nodeId,
        identity.clusterId,
        m.mfcc === undefined ? null : toRealMatrix(m.mfcc),
        m.confidence === undefined ? null : Math.fround(m.confidence),
        m.model_version ?? null,
        m.snr_db === undefined ? null : Math.fround(m.snr_db),
        m.rssi_dbm ?? null,
        m.msg_id ?? null,
        m.received_at ?? null,
        m.schema_version ?? 1,
      ],
    );
    return rowCount === 1 ? "stored" : "duplicate";
  });
}

export async function storeNodeHealth(
  identity: ClusterIdentity,
  h: NodeHealth,
): Promise<StoreResult> {
  return withOrg(identity.orgId, async (client) => {
    const nodeId = await findNodeId(client, identity.clusterId, h.node_id);
    if (nodeId === null) return "unknown_node";
    const { rowCount } = await client.query(
      `INSERT INTO node_health ("timestamp", org_id, node_id, battery_mv, rssi_dbm, uptime_s)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (node_id, "timestamp") DO NOTHING`,
      [
        h.timestamp,
        identity.orgId,
        nodeId,
        h.battery_mv ?? null,
        h.rssi_dbm ?? null,
        h.uptime_s ?? null,
      ],
    );
    return rowCount === 1 ? "stored" : "duplicate";
  });
}

export async function storeClusterHealth(
  identity: ClusterIdentity,
  h: ClusterHealth,
): Promise<StoreResult> {
  return withOrg(identity.orgId, async (client) => {
    const { rowCount } = await client.query(
      `INSERT INTO cluster_health
         ("timestamp", org_id, cluster_id, uptime_s, rssi_dbm, sd_free_mb, uplink_type, buffered_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (cluster_id, "timestamp") DO NOTHING`,
      [
        h.timestamp,
        identity.orgId,
        identity.clusterId,
        h.uptime_s ?? null,
        h.rssi_dbm ?? null,
        h.sd_free_mb ?? null,
        h.uplink_type ?? null,
        h.buffered_count ?? null,
      ],
    );
    return rowCount === 1 ? "stored" : "duplicate";
  });
}

function loraIdFrom(parsedBody: unknown): number | null {
  if (typeof parsedBody !== "object" || parsedBody === null) return null;
  const value = (parsedBody as { node_id?: unknown }).node_id;
  // An int4 column: anything larger isn't a LoRa ID worth keeping.
  return Number.isInteger(value) && Math.abs(value as number) < 2 ** 31
    ? (value as number)
    : null;
}

/**
 * Records a rejected request so its organization can see it. An unknown node keeps the whole
 * body, so it could be replayed once the node is registered; anything else keeps an excerpt.
 * Never throws: failing to log a reject must not change what the Pi is told.
 */
export async function recordReject(
  identity: ClusterIdentity,
  httpStatus: number,
  errorCode: string,
  rawBody: string,
  parsedBody: unknown,
): Promise<void> {
  const limit =
    errorCode === "unknown_node" ? STORED_BODY_MAX_CHARS : EXCERPT_CHARS;
  // Postgres text can't hold NUL, which is legal in the bytes a client sends us.
  const body = rawBody.replaceAll("\u0000", "").slice(0, limit);
  try {
    await withOrg(identity.orgId, (client) =>
      client.query(
        `INSERT INTO ingest_rejects (org_id, cluster_id, lora_id, http_status, error_code, request_body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          identity.orgId,
          identity.clusterId,
          loraIdFrom(parsedBody),
          httpStatus,
          errorCode,
          body,
        ],
      ),
    );
  } catch (error) {
    console.error("could not record ingest reject", error);
  }
}
