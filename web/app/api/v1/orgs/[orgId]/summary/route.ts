import { z } from "zod";
import { queryParams } from "@/lib/api/pagination";
import { withOrgAccess } from "@/lib/auth/guard";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";
import { errorResponse } from "@/lib/ingest/responses";

const querySchema = z.object({ zone: z.string().max(200).optional() });

type Params = { params: Promise<{ orgId: string }> };

export async function GET(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const { orgId } = await params;
  return withOrgAccess(request, orgId, async () => {
    const query = querySchema.safeParse(queryParams(request));
    if (!query.success)
      return errorResponse(400, "invalid_query", "Bad query parameters");
    const { rows } = await withOrg(orgId, (client) =>
      client.query(queries.summary_cards, [query.data.zone ?? null]),
    );
    return Response.json(rows[0]);
  });
}
