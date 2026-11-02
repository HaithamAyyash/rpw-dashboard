import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

type Row = { node_id: string; [column: string]: unknown };

/** Asks for one row more than a page, to know whether there's a next one without counting. */
export async function featurePage(
  orgId: string,
  nodeId: string | null,
  [from, to]: [string, string],
  includeMfcc: boolean,
  zone: string | undefined,
  [limit, offset]: [number, number],
  page: { page: number; page_size: number },
) {
  const { rows } = await withOrg(orgId, (client) =>
    client.query<Row>(queries.historical_records, [
      nodeId,
      from,
      to,
      includeMfcc,
      limit + 1,
      offset,
      zone ?? null,
    ]),
  );
  return {
    items: rows.slice(0, limit).map(({ mfcc, ...row }) => ({
      ...row,
      node_id: Number(row.node_id),
      ...(includeMfcc ? { mfcc } : {}),
    })),
    has_more: rows.length > limit,
    page: page.page,
    page_size: page.page_size,
  };
}
