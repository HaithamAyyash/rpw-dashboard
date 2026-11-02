import { orgGet } from "@/lib/api/route";
import { noQuery } from "@/lib/api/schemas";
import { withOrg } from "@/lib/db/withOrg";

export const GET = orgGet(noQuery, async ({ orgId, context }) => {
  const { rows } = await withOrg(orgId, (client) =>
    client.query(
      `SELECT u.user_id, u.email, u.name, m.role, m.created_at, u.last_login
       FROM organization_members m JOIN users u ON u.user_id = m.user_id
       WHERE m.org_id = $1 ORDER BY u.name, u.email`,
      [orgId],
    ),
  );
  return Response.json({ items: rows, you: context.user.user_id });
});
