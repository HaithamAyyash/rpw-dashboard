import { limitOffset } from "@/lib/api/pagination";
import { orgGet } from "@/lib/api/route";
import { pageQuery } from "@/lib/api/schemas";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

type Row = {
  node_id: string;
  uptime_s: string | null;
  total_count: string;
  [column: string]: unknown;
};

export const GET = orgGet(pageQuery, async ({ orgId, input }) => {
  const { rows } = await withOrg(orgId, (client) =>
    client.query<Row>(queries.node_health, [
      ...limitOffset(input),
      input.zone ?? null,
    ]),
  );
  return Response.json({
    items: rows.map(({ total_count: _total, ...row }) => ({
      ...row,
      node_id: Number(row.node_id),
      uptime_s: row.uptime_s === null ? null : Number(row.uptime_s),
    })),
    total: Number(rows[0]?.total_count ?? 0),
    page: input.page,
    page_size: input.page_size,
  });
});
