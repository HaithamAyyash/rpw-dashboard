import { z } from "zod";
import {
  limitOffset,
  paginationSchema,
  queryParams,
} from "@/lib/api/pagination";
import { withOrgAccess } from "@/lib/auth/guard";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";
import { errorResponse } from "@/lib/ingest/responses";

const querySchema = z.object({
  zone: z.string().max(200).optional(),
  status: z
    .enum(["healthy", "suspected", "alert", "offline", "unknown"])
    .optional(),
  q: z.string().max(200).optional(),
  ...paginationSchema,
});

type Row = {
  node_id: string;
  avg_confidence: string | null;
  total_count: string;
  [column: string]: unknown;
};

type Params = { params: Promise<{ orgId: string }> };

export async function GET(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const { orgId } = await params;
  return withOrgAccess(request, orgId, async () => {
    const parsed = querySchema.safeParse(queryParams(request));
    if (!parsed.success)
      return errorResponse(400, "invalid_query", "Bad query parameters");
    const query = parsed.data;
    const { rows } = await withOrg(orgId, (client) =>
      client.query<Row>(queries.tree_cards, [
        query.zone ?? null,
        query.status ?? null,
        query.q ?? null,
        ...limitOffset(query),
      ]),
    );
    return Response.json({
      items: rows.map((row) => ({
        ...row,
        total_count: undefined,
        node_id: Number(row.node_id),
        avg_confidence:
          row.avg_confidence === null ? null : Number(row.avg_confidence),
      })),
      total: Number(rows[0]?.total_count ?? 0),
      page: query.page,
      page_size: query.page_size,
    });
  });
}
