import { isBigintId, notFound, orgGet } from "@/lib/api/route";
import { noQuery } from "@/lib/api/schemas";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

export const GET = orgGet(noQuery, async ({ orgId, params }) => {
  if (!isBigintId(params.nodeId)) return notFound();
  const { rows } = await withOrg(orgId, (client) =>
    client.query(queries.tree_detail, [params.nodeId]),
  );
  const row = rows[0];
  if (!row) return notFound();
  return Response.json({
    ...row,
    node_id: Number(row.node_id),
    avg_confidence:
      row.avg_confidence === null ? null : Number(row.avg_confidence),
  });
});
