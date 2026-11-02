import { limitOffset } from "@/lib/api/pagination";
import { orgGet } from "@/lib/api/route";
import { alertsQuery, range } from "@/lib/api/schemas";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

type Row = {
  alert_id: string;
  node_id: string | null;
  [column: string]: unknown;
};

export const GET = orgGet(alertsQuery, async ({ orgId, input }) => {
  const [limit, offset] = limitOffset(input);
  const [from, to] = range(input, 365 * 10); // alerts are kept forever
  const { rows } = await withOrg(orgId, (client) =>
    client.query<Row>(queries.alerts, [
      from,
      to,
      input.severity ?? null,
      input.acknowledged === undefined ? null : input.acknowledged === "true",
      limit + 1,
      offset,
      input.zone ?? null,
    ]),
  );
  return Response.json({
    items: rows.slice(0, limit).map((row) => ({
      ...row,
      alert_id: Number(row.alert_id),
      node_id: row.node_id === null ? null : Number(row.node_id),
    })),
    has_more: rows.length > limit,
    page: input.page,
    page_size: input.page_size,
  });
});
