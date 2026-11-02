import { ingestHandler } from "@/lib/ingest/handler";
import { storeMeasurement } from "@/lib/ingest/store";
import { measurementSchema } from "@/lib/schemas/ingest";

/** Contract: docs/contracts/cluster_head_to_cloud.md */
export const POST = ingestHandler(measurementSchema, storeMeasurement);
