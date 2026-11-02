import { z } from "zod";
import { notFound, orgWrite } from "@/lib/api/route";
import { withOrg } from "@/lib/db/withOrg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The last owner can't be removed: the database refuses, and orgWrite explains why. */
export const DELETE = orgWrite(z.object({}), async ({ orgId, params }) => {
  if (!UUID.test(params.userId ?? "")) return notFound();
  const { rowCount } = await withOrg(orgId, (client) =>
    client.query(
      "DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2",
      [orgId, params.userId],
    ),
  );
  return rowCount ? new Response(null, { status: 204 }) : notFound();
});
