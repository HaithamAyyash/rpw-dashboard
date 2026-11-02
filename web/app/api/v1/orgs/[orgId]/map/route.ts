import { orgGet } from "@/lib/api/route";
import { zoneQuery } from "@/lib/api/schemas";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

type NodeRow = {
  node_id: string;
  avg_confidence: string | null;
  [column: string]: unknown;
};

export const GET = orgGet(zoneQuery, async ({ orgId, input }) => {
  const [nodes, clusters] = await withOrg(orgId, async (client) => [
    (await client.query<NodeRow>(queries.map_nodes, [input.zone ?? null])).rows,
    (await client.query(queries.map_clusters)).rows,
  ]);
  return Response.json({
    nodes: (nodes as NodeRow[]).map((n) => ({
      ...n,
      node_id: Number(n.node_id),
      avg_confidence:
        n.avg_confidence === null ? null : Number(n.avg_confidence),
    })),
    clusters,
  });
});
