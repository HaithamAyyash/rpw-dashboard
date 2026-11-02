import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { z } from "zod";
import { databaseErrorResponse } from "@/lib/api/route";
import { loadUser } from "@/lib/auth/current";
import { originAllowed } from "@/lib/auth/guard";
import {
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  signSession,
  verifySession,
} from "@/lib/auth/session";
import { pool } from "@/lib/db/pool";
import { withOrgAndUser } from "@/lib/db/withOrg";
import { errorResponse } from "@/lib/ingest/responses";
import { hashToken } from "@/lib/settings/tokens";

type Params = { params: Promise<{ token: string }> };
type Invite = {
  invite_id: string;
  org_id: string;
  email: string;
  role: string;
  account_exists: boolean;
};

const newAccountSchema = z.object({
  name: z.string().trim().min(1).max(200),
  password: z.string().min(10).max(1024),
});

const JOIN_SQL =
  "INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING";
const USE_SQL =
  "UPDATE organization_invites SET accepted_at = now() WHERE invite_id = $1 AND accepted_at IS NULL";

const expired = () =>
  errorResponse(
    404,
    "not_found",
    "This invite has expired or was already used",
  );

export async function POST(
  request: Request,
  { params }: Params,
): Promise<Response> {
  try {
    if (!originAllowed(request)) {
      return errorResponse(403, "bad_origin", "Request origin not allowed");
    }
    const { token } = await params;
    const { rows } = await pool().query<Invite>(
      "SELECT invite_id, org_id, email, role, account_exists FROM invite_by_token($1)",
      [hashToken(token)],
    );
    const invite = rows[0];
    if (!invite) return expired();
    return invite.account_exists
      ? await acceptExisting(request, invite)
      : await acceptNew(request, invite);
  } catch (error) {
    const friendly = databaseErrorResponse(error);
    if (friendly) return friendly;
    console.error("accept invite failed", error);
    return errorResponse(500, "server_error", "Something went wrong");
  }
}

/** The token alone never grants access to an existing account: its owner must be logged in. */
async function acceptExisting(
  request: Request,
  invite: Invite,
): Promise<Response> {
  const claims = await verifySession(readCookie(request, SESSION_COOKIE));
  const user = claims ? await loadUser(claims) : null;
  if (!user)
    return errorResponse(401, "login_required", "Log in to accept this invite");
  if (user.email !== invite.email) {
    return errorResponse(
      403,
      "wrong_account",
      `This invite is for ${invite.email}`,
    );
  }
  const used = await withOrgAndUser(
    invite.org_id,
    user.user_id,
    async (client) => {
      const { rowCount } = await client.query(USE_SQL, [invite.invite_id]);
      if (rowCount !== 1) return false;
      await client.query(JOIN_SQL, [invite.org_id, user.user_id, invite.role]);
      return true;
    },
  );
  return used ? Response.json({ status: "joined" }) : expired();
}

async function acceptNew(request: Request, invite: Invite): Promise<Response> {
  const parsed = newAccountSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return errorResponse(
      400,
      "invalid_body",
      "Enter your name and a password of at least 10 characters",
    );
  }
  const userId = randomUUID();
  const passwordHash = await hash(parsed.data.password);
  const used = await withOrgAndUser(invite.org_id, userId, async (client) => {
    const { rowCount } = await client.query(USE_SQL, [invite.invite_id]);
    if (rowCount !== 1) return false;
    await client.query(
      "INSERT INTO users (user_id, email, name, password_hash) VALUES ($1, $2, $3, $4)",
      [userId, invite.email, parsed.data.name, passwordHash],
    );
    await client.query(JOIN_SQL, [invite.org_id, userId, invite.role]);
    return true;
  });
  if (!used) return expired();
  const response = Response.json({ status: "joined" }, { status: 201 });
  response.headers.append(
    "Set-Cookie",
    sessionCookie(await signSession(userId, 0)),
  );
  return response;
}
