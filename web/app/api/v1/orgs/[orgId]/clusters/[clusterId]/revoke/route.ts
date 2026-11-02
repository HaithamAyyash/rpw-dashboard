import { z } from "zod";
import { notFound, orgWrite } from "@/lib/api/route";
import { withOrg } from "@/lib/db/withOrg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = orgWrite(z.object({}), async ({ orgId, params }) => {
  if (!UUID.test(params.clusterId ?? "")) return notFound();
  const { rowCount } = await withOrg(orgId, (client) =>
    client.query(
      "UPDATE cluster_heads SET revoked = true WHERE cluster_id = $1 AND org_id = $2",
      [params.clusterId, orgId],
    ),
  );
  return rowCount ? Response.json({ revoked: true }) : notFound();
});
