import { createHash, randomBytes } from "node:crypto";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function appBaseUrl(): string {
  const origin = (process.env.APP_ORIGIN ?? "").split(",")[0]?.trim();
  return origin || "http://localhost:3100";
}
