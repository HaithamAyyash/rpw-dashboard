import { limitOffset } from "@/lib/api/pagination";
import { orgGet } from "@/lib/api/route";
import { classificationsQuery, range } from "@/lib/api/schemas";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

type Row = { node_id: string; total_count?: string; [column: string]: unknown };

/** The latest result per node by default; any of from, to or node_id switches to every result. */
export const GET = orgGet(classificationsQuery, async ({ orgId, input }) => {
  const [limit, offset] = limitOffset(input);
  const base = { page: input.page, page_size: input.page_size };
  if (!input.from && !input.to && !input.node_id) {
    const { rows } = await withOrg(orgId, (client) =>
      client.query<Row>(queries.classification_latest, [
        input.label ?? null,
        input.min_conf ?? null,
        input.sort ?? "confidence_desc",
        limit,
        offset,
        input.zone ?? null,
      ]),
    );
    return Response.json({
      ...base,
      items: rows.map(({ total_count: _total, ...row }) => ({
        ...row,
        node_id: Number(row.node_id),
      })),
      total: Number(rows[0]?.total_count ?? 0),
    });
  }
  const [from, to] = range(input, 7);
  const { rows } = await withOrg(orgId, (client) =>
    client.query<Row>(queries.classification_history, [
      from,
      to,
      input.node_id ?? null,
      input.label ?? null,
      input.min_conf ?? null,
      input.sort ?? "time_desc",
      limit + 1,
      offset,
      input.zone ?? null,
    ]),
  );
  return Response.json({
    ...base,
    items: rows
      .slice(0, limit)
      .map((row) => ({ ...row, node_id: Number(row.node_id) })),
    has_more: rows.length > limit,
  });
});
