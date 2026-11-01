// Usage: npm run create-org -- --name "Al Ain Farms" --slug al-ain --owner-email a@b.c --owner-name "A B"
// Set OWNER_PASSWORD to choose the password; otherwise one is generated and printed once.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { createOrg } from "@/lib/admin";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    slug: { type: "string" },
    "owner-email": { type: "string" },
    "owner-name": { type: "string" },
    timezone: { type: "string" },
  },
});

async function main() {
  const { name, slug, timezone } = values;
  const ownerEmail = values["owner-email"];
  const ownerName = values["owner-name"];
  if (!name || !slug || !ownerEmail || !ownerName) {
    throw new Error("Required: --name --slug --owner-email --owner-name");
  }
  const generated = !process.env.OWNER_PASSWORD;
  const ownerPassword =
    process.env.OWNER_PASSWORD ?? randomBytes(18).toString("base64url");
  const { orgId } = await createOrg({
    name,
    slug,
    ownerEmail,
    ownerName,
    ownerPassword,
    timezone,
  });
  console.log(`Organization "${name}" created: ${orgId}`);
  console.log(`Owner: ${ownerEmail}`);
  if (generated) {
    console.log(`Password (shown once): ${ownerPassword}`);
  }
}

main().catch((error: Error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
