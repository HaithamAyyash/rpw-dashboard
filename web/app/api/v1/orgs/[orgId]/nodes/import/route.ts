import { z } from "zod";
import { parseCsv } from "@/lib/api/csv";
import { databaseErrorResponse, orgWrite } from "@/lib/api/route";
import { withOrg } from "@/lib/db/withOrg";
import { errorResponse } from "@/lib/ingest/responses";
import { INSERT_NODE_SQL, nodeFields } from "@/lib/settings/nodes";

const REQUIRED = ["lora_id", "tree_label", "cluster"];
const MAX_ROWS = 10_000;

const rowSchema = z.object(nodeFields);
const number = (text: string | undefined) => (text ? Number(text) : undefined);

/**
 * Body: {"csv": "lora_id,tree_label,cluster,farm_zone,location_lat,location_lon\n..."}.
 * All or nothing: one bad row imports none, and the answer lists every problem by line.
 */
export const POST = orgWrite(
  z.object({ csv: z.string().max(2_000_000) }),
  async ({ orgId, input }) => {
    const [header, ...lines] = parseCsv(input.csv);
    const columns = (header ?? []).map((c) => c.trim().toLowerCase());
    const missing = REQUIRED.filter((c) => !columns.includes(c));
    if (missing.length > 0) {
      return errorResponse(
        400,
        "invalid_body",
        `Missing columns: ${missing.join(", ")}`,
      );
    }
    if (lines.length === 0)
      return errorResponse(400, "invalid_body", "The file has no rows");
    if (lines.length > MAX_ROWS) {
      return errorResponse(
        400,
        "invalid_body",
        `At most ${MAX_ROWS} rows can be imported at once`,
      );
    }

    const problems: { line: number; message: string }[] = [];
    const parsed = lines.map((line, index) => {
      const get = (name: string) =>
        line[columns.indexOf(name)]?.trim() || undefined;
      const result = rowSchema.safeParse({
        lora_id: number(get("lora_id")),
        tree_label: get("tree_label"),
        farm_zone: get("farm_zone"),
        location_lat: number(get("location_lat")),
        location_lon: number(get("location_lon")),
      });
      if (!result.success) {
        const issue = result.error.issues[0]!;
        problems.push({
          line: index + 2,
          message: `${issue.path.join(".")}: ${issue.message}`,
        });
      }
      return { cluster: get("cluster"), data: result.data };
    });

    const imported = await withOrg(orgId, async (client) => {
      const clusters = await client.query<{ cluster_id: string; name: string }>(
        "SELECT cluster_id, name FROM cluster_heads WHERE org_id = $1",
        [orgId],
      );
      const idOf = new Map(clusters.rows.map((c) => [c.name, c.cluster_id]));
      parsed.forEach((row, index) => {
        if (row.cluster === undefined || !idOf.has(row.cluster)) {
          problems.push({
            line: index + 2,
            message: `No cluster head named "${row.cluster ?? ""}"`,
          });
        }
      });
      if (problems.length > 0) return 0;

      let count = 0;
      for (const [index, row] of parsed.entries()) {
        const data = row.data!;
        try {
          await client.query("SAVEPOINT row_insert");
          await client.query(INSERT_NODE_SQL, [
            orgId,
            idOf.get(row.cluster!),
            data.lora_id,
            data.tree_label,
            data.farm_zone ?? null,
            data.location_lat ?? null,
            data.location_lon ?? null,
          ]);
          await client.query("RELEASE SAVEPOINT row_insert");
          count += 1;
        } catch (error) {
          if (!databaseErrorResponse(error)) throw error;
          await client.query("ROLLBACK TO SAVEPOINT row_insert");
          problems.push({
            line: index + 2,
            message: `LoRa ID ${data.lora_id} is already in use under ${row.cluster}`,
          });
        }
      }
      if (problems.length > 0) throw new ImportFailed();
      return count;
    }).catch((error) => {
      if (error instanceof ImportFailed) return 0;
      throw error;
    });

    if (problems.length > 0) {
      problems.sort((a, b) => a.line - b.line);
      return errorResponse(
        400,
        "invalid_body",
        "Nothing was imported. Fix these rows and try again",
        problems,
      );
    }
    return Response.json({ imported }, { status: 201 });
  },
);

/** Rolls the transaction back, so a file with a bad row imports nothing. */
class ImportFailed extends Error {}
