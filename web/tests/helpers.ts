import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createOrg, registerCluster } from "@/lib/admin";

export async function ownerQuery<T extends object>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL_ADMIN,
  });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

export type TestOrg = {
  slug: string;
  orgId: string;
  clusterId: string;
  apiKey: string;
};

export async function makeOrg(
  loraIds: number[] = [1000, 1001],
): Promise<TestOrg> {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const { orgId } = await createOrg({
    name: slug,
    slug,
    ownerEmail: `${slug}@test.example`,
    ownerName: "Owner",
    ownerPassword: "test-password",
  });
  const cluster = await registerCluster({
    orgSlug: slug,
    name: "CH-01",
    loraIds,
  });
  return {
    slug,
    orgId,
    clusterId: cluster.clusterId,
    apiKey: cluster.apiKey!,
  };
}

export function mfcc(value = -312.5): number[][] {
  return Array.from({ length: 30 }, () => Array<number>(13).fill(value));
}

export function isoAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

let tick = 0;
/** A valid body with a timestamp no other test uses. */
export function body(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { timestamp: string } {
  tick += 1;
  return {
    node_id: 1000,
    timestamp: new Date(Date.now() - 3_600_000 - tick * 1000).toISOString(),
    mfcc: mfcc(),
    ...overrides,
  } as Record<string, unknown> & { timestamp: string };
}
