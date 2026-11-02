import { orgGet } from "@/lib/api/route";
import { BUCKETS, energyQuery, range } from "@/lib/api/schemas";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

export const GET = orgGet(energyQuery, async ({ orgId, input }) => {
  const [from, to] = range(input, 1);
  const { rows } = await withOrg(orgId, (client) =>
    client.query(queries.energy_overview, [
      from,
      to,
      BUCKETS[input.bucket],
      input.zone ?? null,
    ]),
  );
  return Response.json({ items: rows });
});
