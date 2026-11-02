import { z } from "zod";
import { orgGet, orgWrite } from "@/lib/api/route";
import { noQuery } from "@/lib/api/schemas";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";
import { errorResponse } from "@/lib/ingest/responses";

function numbers(row: Record<string, unknown>) {
  return {
    ...row,
    suspect_threshold: Number(row.suspect_threshold),
    alert_threshold: Number(row.alert_threshold),
  };
}

export const GET = orgGet(noQuery, async ({ orgId }) => {
  const { rows } = await withOrg(orgId, (client) =>
    client.query(queries.organization),
  );
  return Response.json(numbers(rows[0]));
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().min(1).max(100).optional(),
  suspect_threshold: z.number().min(0).max(1).optional(),
  alert_threshold: z.number().min(0).max(1).optional(),
});

export const PATCH = orgWrite(patchSchema, async ({ orgId, input }) => {
  const row = await withOrg(orgId, async (client) => {
    const current = (await client.query(queries.organization)).rows[0];
    const suspect =
      input.suspect_threshold ?? Number(current.suspect_threshold);
    const alert = input.alert_threshold ?? Number(current.alert_threshold);
    if (suspect >= alert) return null;
    await client.query(
      `UPDATE organizations SET name = $1, timezone = $2, suspect_threshold = $3, alert_threshold = $4
       WHERE org_id = $5`,
      [
        input.name ?? current.name,
        input.timezone ?? current.timezone,
        suspect,
        alert,
        orgId,
      ],
    );
    return (await client.query(queries.organization)).rows[0];
  });
  if (!row) {
    return errorResponse(
      400,
      "invalid_value",
      "The suspect threshold must be below the alert threshold",
    );
  }
  return Response.json(numbers(row));
});
