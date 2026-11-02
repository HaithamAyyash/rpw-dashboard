import { z } from "zod";
import { isBigintId, notFound, orgWrite } from "@/lib/api/route";
import { withOrg } from "@/lib/db/withOrg";

/** Acknowledge. Repeating it keeps whoever acknowledged first. */
export const PATCH = orgWrite(
  z.object({ acknowledged: z.literal(true) }),
  async ({ orgId, params, context }) => {
    if (!isBigintId(params.alertId)) return notFound();
    const row = await withOrg(orgId, async (client) => {
      await client.query(
        `UPDATE alert_log SET acknowledged = true, acknowledged_by = $1, acknowledged_at = now()
         WHERE alert_id = $2 AND NOT acknowledged`,
        [context.user.user_id, params.alertId],
      );
      const { rows } = await client.query(
        "SELECT alert_id, acknowledged, acknowledged_at FROM alert_log WHERE alert_id = $1",
        [params.alertId],
      );
      return rows[0];
    });
    return row
      ? Response.json({ ...row, alert_id: Number(row.alert_id) })
      : notFound();
  },
);
