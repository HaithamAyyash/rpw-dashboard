import { withOrgAccess } from "@/lib/auth/guard";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

type Params = { params: Promise<{ orgId: string }> };

export async function GET(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const { orgId } = await params;
  return withOrgAccess(request, orgId, async () => {
    const { rows } = await withOrg(orgId, (client) =>
      client.query(queries.zones),
    );
    return Response.json({ items: rows });
  });
}
