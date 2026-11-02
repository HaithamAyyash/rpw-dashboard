import { ingestHandler } from "@/lib/ingest/handler";
import { storeClusterHealth } from "@/lib/ingest/store";
import { clusterHealthSchema } from "@/lib/schemas/ingest";

export const POST = ingestHandler(clusterHealthSchema, storeClusterHealth);
