import { randomBytes } from "node:crypto";

export function newApiKey(): string {
  return `nkh_${randomBytes(32).toString("base64url")}`;
}
