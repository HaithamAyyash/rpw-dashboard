import { orgGet } from "@/lib/api/route";
import { noQuery } from "@/lib/api/schemas";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

type Row = { uptime_s: string | null; [column: string]: unknown };

export const GET = orgGet(noQuery, async ({ orgId }) => {
  const { rows } = await withOrg(orgId, (client) =>
    client.query<Row>(queries.cluster_health),
  );
  return Response.json({
    items: rows.map((row) => ({
      ...row,
      uptime_s: row.uptime_s === null ? null : Number(row.uptime_s),
    })),
  });
});
