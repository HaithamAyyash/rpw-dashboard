import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";
import { originAllowed } from "@/lib/auth/guard";
import { sessionCookie, signSession } from "@/lib/auth/session";
import { pool } from "@/lib/db/pool";
import { withUser } from "@/lib/db/withOrg";
import { errorResponse } from "@/lib/ingest/responses";

const loginSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(1024),
});

type UserRow = {
  user_id: string;
  name: string;
  password_hash: string;
  token_version: number;
};

// Verified when the email is unknown, so a wrong email takes as long as a wrong password and
// response time doesn't reveal who has an account.
const decoyHash = hash("nakhel-decoy-password");

export async function POST(request: Request): Promise<Response> {
  try {
    if (!originAllowed(request)) {
      return errorResponse(403, "bad_origin", "Request origin not allowed");
    }
    const parsed = loginSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return errorResponse(
        400,
        "invalid_body",
        "Email and password are required",
      );
    }
    const { rows } = await pool().query<UserRow>(
      "SELECT user_id, name, password_hash, token_version FROM auth_user_by_email($1)",
      [parsed.data.email],
    );
    const user = rows[0];
    const valid = await verify(
      user?.password_hash ?? (await decoyHash),
      parsed.data.password,
    );
    if (!user || !valid) {
      return errorResponse(
        401,
        "invalid_credentials",
        "Wrong email or password",
      );
    }
    await withUser(user.user_id, (client) =>
      client.query("UPDATE users SET last_login = now() WHERE user_id = $1", [
        user.user_id,
      ]),
    );
    const response = Response.json({
      user: { user_id: user.user_id, name: user.name },
    });
    response.headers.append(
      "Set-Cookie",
      sessionCookie(await signSession(user.user_id, user.token_version)),
    );
    return response;
  } catch (error) {
    console.error("login failed", error);
    return errorResponse(500, "server_error", "Something went wrong");
  }
}
