import { z } from "zod";
import { newApiKey } from "@/lib/api-keys";
import { notFound, orgWrite } from "@/lib/api/route";
import { withOrg } from "@/lib/db/withOrg";
import { hashApiKey } from "@/lib/ingest/store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The old key stops working at once. This also brings a revoked cluster head back. */
export const POST = orgWrite(z.object({}), async ({ orgId, params }) => {
  if (!UUID.test(params.clusterId ?? "")) return notFound();
  const apiKey = newApiKey();
  const { rowCount } = await withOrg(orgId, (client) =>
    client.query(
      "UPDATE cluster_heads SET api_key_hash = $1, api_key_created_at = now(), revoked = false WHERE cluster_id = $2 AND org_id = $3",
      [hashApiKey(apiKey), params.clusterId, orgId],
    ),
  );
  return rowCount ? Response.json({ api_key: apiKey }) : notFound();
});
