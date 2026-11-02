// Generates the JSON Schema the Pi team builds against. Run: npm run contracts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  clusterHealthSchema,
  measurementSchema,
  nodeHealthSchema,
} from "@/lib/schemas/ingest";

export function measurementJsonSchema(): string {
  const schema = {
    title: "NAKHEL measurement",
    description:
      "Body of POST /api/v1/ingest/measurements. Generated from web/lib/schemas/ingest.ts; do not edit.",
    ...z.toJSONSchema(measurementSchema),
  };
  return `${JSON.stringify(schema, null, 2)}\n`;
}

function healthSchema(title: string, schema: z.ZodType): string {
  return `${JSON.stringify(
    {
      title,
      description: "Generated from web/lib/schemas/ingest.ts; do not edit.",
      ...z.toJSONSchema(schema),
    },
    null,
    2,
  )}\n`;
}

export const nodeHealthJsonSchema = () =>
  healthSchema("NAKHEL node health", nodeHealthSchema);
export const clusterHealthJsonSchema = () =>
  healthSchema("NAKHEL cluster health", clusterHealthSchema);

if (process.argv[1]?.endsWith("gen-contracts.ts")) {
  const dir = path.resolve(__dirname, "../../docs/contracts");
  writeFileSync(
    path.join(dir, "measurement.schema.json"),
    measurementJsonSchema(),
  );
  writeFileSync(
    path.join(dir, "node_health.schema.json"),
    nodeHealthJsonSchema(),
  );
  writeFileSync(
    path.join(dir, "cluster_health.schema.json"),
    clusterHealthJsonSchema(),
  );
  console.log(`wrote schemas to ${dir}`);
}
