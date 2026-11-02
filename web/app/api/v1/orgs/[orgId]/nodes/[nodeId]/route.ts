import { isBigintId, notFound, orgWrite } from "@/lib/api/route";
import { withOrg } from "@/lib/db/withOrg";
import { errorResponse } from "@/lib/ingest/responses";
import { ownsCluster, updateNodeSchema } from "@/lib/settings/nodes";

const BAD_CLUSTER = Symbol("bad cluster");

export const PATCH = orgWrite(
  updateNodeSchema,
  async ({ orgId, input, params }) => {
    if (!isBigintId(params.nodeId)) return notFound();
    const row = await withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM nodes WHERE node_id = $1 AND org_id = $2",
        [params.nodeId, orgId],
      );
      const current = rows[0];
      if (!current) return null;
      if (input.cluster_id && !(await ownsCluster(client, input.cluster_id)))
        return BAD_CLUSTER;
      const pick = <K extends keyof typeof input>(key: K) =>
        input[key] === undefined ? current[key] : input[key];
      const updated = await client.query(
        `UPDATE nodes SET lora_id = $1, tree_label = $2, cluster_id = $3, farm_zone = $4, location_lat = $5,
              location_lon = $6, active = $7, updated_at = now()
       WHERE node_id = $8 AND org_id = $9 RETURNING node_id, lora_id, tree_label, cluster_id, farm_zone, location_lat, location_lon, active`,
        [
          pick("lora_id"),
          pick("tree_label"),
          pick("cluster_id"),
          pick("farm_zone"),
          pick("location_lat"),
          pick("location_lon"),
          pick("active"),
          params.nodeId,
          orgId,
        ],
      );
      return updated.rows[0];
    });
    if (row === BAD_CLUSTER) {
      return errorResponse(400, "invalid_value", "That value isn't allowed");
    }
    return row
      ? Response.json({ ...row, node_id: Number(row.node_id) })
      : notFound();
  },
);
