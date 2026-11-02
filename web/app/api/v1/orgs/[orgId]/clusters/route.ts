import { z } from "zod";
import { newApiKey } from "@/lib/api-keys";
import { orgGet, orgWrite } from "@/lib/api/route";
import { noQuery } from "@/lib/api/schemas";
import { withOrg } from "@/lib/db/withOrg";
import { hashApiKey } from "@/lib/ingest/store";

export const GET = orgGet(noQuery, async ({ orgId }) => {
  const { rows } = await withOrg(orgId, (client) =>
    client.query(
      `SELECT c.cluster_id, c.name, c.farm_zone, c.install_date, c.location_lat, c.location_lon,
              c.uplink_type, c.api_key_created_at, c.revoked,
              (SELECT count(*)::int FROM nodes n WHERE n.org_id = c.org_id AND n.cluster_id = c.cluster_id AND n.active) AS node_count
       FROM cluster_heads c WHERE c.org_id = $1 ORDER BY c.name`,
      [orgId],
    ),
  );
  return Response.json({ items: rows });
});

const clusterSchema = z.object({
  name: z.string().trim().min(1).max(100),
  farm_zone: z.string().trim().max(200).optional(),
  location_lat: z.number().min(-90).max(90).optional(),
  location_lon: z.number().min(-180).max(180).optional(),
  uplink_type: z.enum(["wifi", "4g"]).optional(),
});

/** The key is returned this once and only its hash is stored. */
export const POST = orgWrite(clusterSchema, async ({ orgId, input }) => {
  const apiKey = newApiKey();
  const { rows } = await withOrg(orgId, (client) =>
    client.query<{ cluster_id: string }>(
      `INSERT INTO cluster_heads (org_id, name, farm_zone, install_date, location_lat, location_lon, uplink_type, api_key_hash)
       VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7) RETURNING cluster_id`,
      [
        orgId,
        input.name,
        input.farm_zone ?? null,
        input.location_lat ?? null,
        input.location_lon ?? null,
        input.uplink_type ?? null,
        hashApiKey(apiKey),
      ],
    ),
  );
  return Response.json(
    { cluster_id: rows[0]!.cluster_id, name: input.name, api_key: apiKey },
    { status: 201 },
  );
});
