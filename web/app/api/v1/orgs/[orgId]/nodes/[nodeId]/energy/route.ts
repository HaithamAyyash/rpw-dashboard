import { isBigintId, notFound, orgGet } from "@/lib/api/route";
import { BUCKETS, energyQuery, range } from "@/lib/api/schemas";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

export const GET = orgGet(energyQuery, async ({ orgId, input, params }) => {
  if (!isBigintId(params.nodeId)) return notFound();
  const [from, to] = range(input, 1);
  const { rows } = await withOrg(orgId, async (client) => {
    const exists = await client.query(
      "SELECT 1 FROM nodes WHERE node_id = $1",
      [params.nodeId],
    );
    if (exists.rowCount === 0) return { rows: null };
    return client.query(queries.energy_node, [
      params.nodeId,
      from,
      to,
      BUCKETS[input.bucket],
    ]);
  });
  return rows ? Response.json({ items: rows }) : notFound();
});
