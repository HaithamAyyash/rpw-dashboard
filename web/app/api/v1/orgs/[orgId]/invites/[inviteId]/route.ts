import { z } from "zod";
import { notFound, orgWrite } from "@/lib/api/route";
import { withOrg } from "@/lib/db/withOrg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELETE = orgWrite(z.object({}), async ({ orgId, params }) => {
  if (!UUID.test(params.inviteId ?? "")) return notFound();
  const { rowCount } = await withOrg(orgId, (client) =>
    client.query(
      "DELETE FROM organization_invites WHERE invite_id = $1 AND org_id = $2 AND accepted_at IS NULL",
      [params.inviteId, orgId],
    ),
  );
  return rowCount ? new Response(null, { status: 204 }) : notFound();
});
