import { orgGet } from "@/lib/api/route";
import { featuresQuery, range } from "@/lib/api/schemas";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

export const GET = orgGet(featuresQuery, async ({ orgId, input }) => {
  const [from, to] = range(input, 7);
  const { rows } = await withOrg(orgId, (client) =>
    client.query(queries.history_summary, [
      input.node_id ?? null,
      from,
      to,
      input.zone ?? null,
    ]),
  );
  return Response.json(rows[0]);
});
