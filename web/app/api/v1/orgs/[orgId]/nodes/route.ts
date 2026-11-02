import { z } from "zod";
import { limitOffset, paginationSchema } from "@/lib/api/pagination";
import { orgGet, orgWrite } from "@/lib/api/route";
import { withOrg } from "@/lib/db/withOrg";
import { errorResponse } from "@/lib/ingest/responses";
import {
  createNodeSchema,
  INSERT_NODE_SQL,
  ownsCluster,
} from "@/lib/settings/nodes";

const listQuery = z.object({
  q: z.string().max(200).optional(),
  ...paginationSchema,
});

type Row = { node_id: string; total_count: string; [column: string]: unknown };

export const GET = orgGet(listQuery, async ({ orgId, input }) => {
  const { rows } = await withOrg(orgId, (client) =>
    client.query<Row>(
      `SELECT n.node_id, n.lora_id, n.tree_label, n.cluster_id, c.name AS cluster_name, n.farm_zone,
              n.location_lat, n.location_lon, n.active, count(*) OVER () AS total_count
       FROM nodes n JOIN cluster_heads c ON c.org_id = n.org_id AND c.cluster_id = n.cluster_id
       WHERE n.org_id = $1 AND ($2::text IS NULL OR n.tree_label ILIKE '%' || $2 || '%' OR n.lora_id::text = $2)
       ORDER BY n.tree_label, n.node_id LIMIT $3 OFFSET $4`,
      [orgId, input.q ?? null, ...limitOffset(input)],
    ),
  );
  return Response.json({
    items: rows.map(({ total_count: _total, ...row }) => ({
      ...row,
      node_id: Number(row.node_id),
    })),
    total: Number(rows[0]?.total_count ?? 0),
    page: input.page,
    page_size: input.page_size,
  });
});

export const POST = orgWrite(createNodeSchema, async ({ orgId, input }) => {
  const nodeId = await withOrg(orgId, async (client) => {
    if (!(await ownsCluster(client, input.cluster_id))) return null;
    const { rows } = await client.query<{ node_id: string }>(INSERT_NODE_SQL, [
      orgId,
      input.cluster_id,
      input.lora_id,
      input.tree_label,
      input.farm_zone ?? null,
      input.location_lat ?? null,
      input.location_lon ?? null,
    ]);
    return rows[0]!.node_id;
  });
  if (nodeId === null)
    return errorResponse(400, "invalid_value", "That value isn't allowed");
  return Response.json({ node_id: Number(nodeId) }, { status: 201 });
});
