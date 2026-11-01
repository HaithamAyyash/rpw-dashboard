import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "nakhel_session";
const SESSION_SECONDS = 12 * 60 * 60;
const REISSUE_AFTER_SECONDS = 6 * 60 * 60;

export type SessionClaims = {
  userId: string;
  tokenVersion: number;
  issuedAt: number;
};

function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET must be set, at least 32 characters");
  }
  return new TextEncoder().encode(value);
}

export async function signSession(
  userId: string,
  tokenVersion: number,
): Promise<string> {
  return new SignJWT({ tv: tokenVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(secret());
}

/** Checks signature and expiry only. Enough for redirects; API routes also check the database. */
export async function verifySession(
  token: string | undefined,
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
    });
    if (!payload.sub || typeof payload.tv !== "number" || !payload.iat)
      return null;
    return {
      userId: payload.sub,
      tokenVersion: payload.tv,
      issuedAt: payload.iat,
    };
  } catch {
    return null;
  }
}

export function shouldReissue(claims: SessionClaims): boolean {
  return Date.now() / 1000 - claims.issuedAt > REISSUE_AFTER_SECONDS;
}

/** Secure unless the app itself is served over plain http (local development only). */
function secureAttribute(): string {
  return allowedOrigins().some((o) => o.startsWith("http://"))
    ? ""
    : "; Secure";
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secureAttribute()}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute()}`;
}

export function allowedOrigins(): string[] {
  return (process.env.APP_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
