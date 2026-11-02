import type { PoolClient } from "pg";
import { z } from "zod";

const optionalText = z.string().trim().max(200).nullish();

export const nodeFields = {
  lora_id: z.number().int().min(0).max(255),
  tree_label: z.string().trim().min(1).max(200),
  farm_zone: optionalText,
  location_lat: z.number().min(-90).max(90).nullish(),
  location_lon: z.number().min(-180).max(180).nullish(),
};

export const createNodeSchema = z.object({
  ...nodeFields,
  cluster_id: z.uuid(),
});

export const updateNodeSchema = z
  .object({
    ...nodeFields,
    cluster_id: z.uuid(),
    active: z.boolean(),
  })
  .partial();

export const INSERT_NODE_SQL = `
  INSERT INTO nodes (org_id, cluster_id, lora_id, tree_label, farm_zone, install_date, location_lat, location_lon)
  VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6, $7) RETURNING node_id`;

/**
 * Row-level security hides other organizations' cluster heads, so this is true only for our own.
 * Checked first: otherwise the unique LoRa index would answer "already in use" for someone else's
 * cluster head and "not allowed" otherwise, letting one organization probe another's LoRa IDs.
 */
export async function ownsCluster(
  client: PoolClient,
  clusterId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    "SELECT 1 FROM cluster_heads WHERE cluster_id = $1",
    [clusterId],
  );
  return rowCount === 1;
}
