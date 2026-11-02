import { orgGet } from "@/lib/api/route";
import { energyQuery, range } from "@/lib/api/schemas";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

/** Ingest -> classification and ingest -> alert latency, for report Table 6.3. */
export const GET = orgGet(energyQuery, async ({ orgId, input }) => {
  const [from, to] = range(input, 7);
  const { rows } = await withOrg(orgId, (client) =>
    client.query(queries.pipeline_latency, [from, to]),
  );
  return Response.json(rows[0]);
});
