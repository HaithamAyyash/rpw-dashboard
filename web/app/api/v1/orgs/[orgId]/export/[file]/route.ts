import { z } from "zod";
import { csvRow } from "@/lib/api/csv";
import { notFound, orgGet } from "@/lib/api/route";
import { rangeSchema, range, zone } from "@/lib/api/schemas";
import { queries } from "@/lib/db/queries.generated";
import { withOrg } from "@/lib/db/withOrg";

const BATCH = 2000;
const MAX_ROWS = 200_000;

const COLUMNS = {
  "features.csv": [
    "node_id",
    "lora_id",
    "tree_label",
    "timestamp",
    "energy",
    "snr_db",
    "rssi_dbm",
    "status",
    "label",
    "confidence",
    "model_version",
  ],
  "classifications.csv": [
    "node_id",
    "lora_id",
    "tree_label",
    "timestamp",
    "model_version",
    "label",
    "confidence",
    "inference_ms",
    "processed_at",
  ],
  "alerts.csv": [
    "alert_id",
    "timestamp",
    "alert_type",
    "severity",
    "confidence",
    "message",
    "tree_label",
    "cluster_name",
    "acknowledged",
    "acknowledged_by_name",
    "acknowledged_at",
    "email_sent_at",
  ],
} as const;

type FileName = keyof typeof COLUMNS;

const exportQuery = z.object({
  ...rangeSchema,
  zone,
  node_id: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
});

/** Streams in batches, so a large export doesn't hold everything in memory at once. */
export const GET = orgGet(
  exportQuery,
  async ({ orgId, input, params, context }) => {
    const file = params.file as FileName;
    if (!Object.hasOwn(COLUMNS, file)) return notFound();
    const [from, to] = range(input, 30);
    const zoneValue = input.zone ?? null;

    function batch(offset: number) {
      return withOrg(orgId, (client) => {
        if (file === "features.csv") {
          return client.query(queries.historical_records, [
            input.node_id ?? null,
            from,
            to,
            false,
            BATCH,
            offset,
            zoneValue,
          ]);
        }
        if (file === "classifications.csv") {
          return client.query(queries.classification_history, [
            from,
            to,
            input.node_id ?? null,
            null,
            null,
            "time_desc",
            BATCH,
            offset,
            zoneValue,
          ]);
        }
        return client.query(queries.alerts, [
          from,
          to,
          null,
          null,
          BATCH,
          offset,
          zoneValue,
        ]);
      });
    }

    const columns = COLUMNS[file];
    let offset = 0;
    let header = true;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (header) {
            header = false;
            controller.enqueue(encoder.encode(csvRow([...columns])));
          }
          const { rows } = await batch(offset);
          if (rows.length > 0) {
            const text = rows
              .map((row) =>
                csvRow(columns.map((c) => (row as Record<string, unknown>)[c])),
              )
              .join("");
            controller.enqueue(encoder.encode(text));
          }
          offset += rows.length;
          if (rows.length < BATCH || offset >= MAX_ROWS) controller.close();
        } catch (error) {
          console.error("export failed", error);
          controller.error(error);
        }
      },
    });
    const name = `nakhel-${context.membership.slug}-${file}`;
    return new Response(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  },
);
