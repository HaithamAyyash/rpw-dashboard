import { randomBytes } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { Client, type ClientBase } from "pg";
import { hashApiKey } from "@/lib/ingest/store";

// Admin scripts connect as the owner role, because they work before any organization is set.
export async function withAdmin<T>(
  fn: (client: ClientBase) => Promise<T>,
): Promise<T> {
  const connectionString = process.env.DATABASE_URL_ADMIN;
  if (!connectionString) throw new Error("DATABASE_URL_ADMIN is not set");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export function newApiKey(): string {
  return `nkh_${randomBytes(32).toString("base64url")}`;
}

/** "1000-1003,2000" -> [1000, 1001, 1002, 1003, 2000] */
export function parseLoraIds(spec: string): number[] {
  const ids = spec.split(",").flatMap((part) => {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) throw new Error(`Bad LoRa ID range: "${part}"`);
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (last < first) throw new Error(`Bad LoRa ID range: "${part}"`);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  });
  const bad = ids.find((id) => id > 65535);
  if (bad !== undefined) throw new Error(`LoRa ID out of range: ${bad}`);
  return [...new Set(ids)];
}

export type OrgInput = {
  name: string;
  slug: string;
  ownerEmail: string;
  ownerName: string;
  ownerPassword: string;
  timezone?: string;
};

/** Creates an organization and its first owner, reusing the account if the email already has one. */
export async function createOrg(input: OrgInput): Promise<{ orgId: string }> {
  const passwordHash = await hash(input.ownerPassword); // argon2id, PHC string
  return withAdmin(async (client) => {
    const org = await client.query<{ org_id: string }>(
      `INSERT INTO organizations (name, slug, timezone)
       VALUES ($1, $2, COALESCE($3, 'Asia/Dubai')) RETURNING org_id`,
      [input.name, input.slug, input.timezone ?? null],
    );
    const orgId = org.rows[0]!.org_id;
    const user = await client.query<{ user_id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING user_id`,
      [input.ownerEmail.toLowerCase(), input.ownerName, passwordHash],
    );
    await client.query(
      "INSERT INTO organization_members (org_id, user_id) VALUES ($1, $2)",
      [orgId, user.rows[0]!.user_id],
    );
    return { orgId };
  });
}

export type ClusterInput = {
  orgSlug: string;
  name: string;
  farmZone?: string;
  lat?: number;
  lon?: number;
  uplink?: string;
  loraIds: number[];
  labelPrefix?: string;
};

export type ClusterResult = {
  clusterId: string;
  nodesAdded: number;
  /** Only set when the cluster head was created by this call. Shown once, stored only hashed. */
  apiKey: string | null;
};

/** Registers the cluster head if it's new, then adds any nodes to it. */
export async function registerCluster(
  input: ClusterInput,
): Promise<ClusterResult> {
  return withAdmin(async (client) => {
    const org = await client.query<{ org_id: string }>(
      "SELECT org_id FROM organizations WHERE slug = $1",
      [input.orgSlug],
    );
    const orgId = org.rows[0]?.org_id;
    if (!orgId) throw new Error(`No organization with slug "${input.orgSlug}"`);

    const existing = await client.query<{ cluster_id: string }>(
      "SELECT cluster_id FROM cluster_heads WHERE org_id = $1 AND name = $2",
      [orgId, input.name],
    );
    let clusterId = existing.rows[0]?.cluster_id;
    let apiKey: string | null = null;
    if (!clusterId) {
      apiKey = newApiKey();
      const created = await client.query<{ cluster_id: string }>(
        `INSERT INTO cluster_heads
           (org_id, name, farm_zone, install_date, location_lat, location_lon, uplink_type, api_key_hash)
         VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7) RETURNING cluster_id`,
        [
          orgId,
          input.name,
          input.farmZone ?? null,
          input.lat ?? null,
          input.lon ?? null,
          input.uplink ?? null,
          hashApiKey(apiKey),
        ],
      );
      clusterId = created.rows[0]!.cluster_id;
    }

    const prefix = input.labelPrefix ?? `${input.name}-N`;
    for (const loraId of input.loraIds) {
      await client.query(
        `INSERT INTO nodes (org_id, cluster_id, lora_id, tree_label, farm_zone, install_date)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)`,
        [
          orgId,
          clusterId,
          loraId,
          `${prefix}${loraId}`,
          input.farmZone ?? null,
        ],
      );
    }
    return { clusterId, nodesAdded: input.loraIds.length, apiKey };
  });
}
