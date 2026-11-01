// Generates the JSON Schema the Pi team builds against. Run: npm run contracts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { measurementSchema } from "@/lib/schemas/ingest";

export function measurementJsonSchema(): string {
  const schema = {
    title: "NAKHEL measurement",
    description:
      "Body of POST /api/v1/ingest/measurements. Generated from web/lib/schemas/ingest.ts; do not edit.",
    ...z.toJSONSchema(measurementSchema),
  };
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1]?.endsWith("gen-contracts.ts")) {
  const target = path.resolve(
    __dirname,
    "../../docs/contracts/measurement.schema.json",
  );
  writeFileSync(target, measurementJsonSchema());
  console.log(`wrote ${target}`);
}
