import { ingestHandler } from "@/lib/ingest/handler";
import { storeNodeHealth } from "@/lib/ingest/store";
import { nodeHealthSchema } from "@/lib/schemas/ingest";

export const POST = ingestHandler(nodeHealthSchema, storeNodeHealth);
