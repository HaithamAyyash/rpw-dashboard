import { pool } from "@/lib/db/pool";
import { withUser } from "@/lib/db/withOrg";
import type { SessionClaims } from "./session";

export type Membership = {
  org_id: string;
  name: string;
  slug: string;
  timezone: string;
  role: string;
};

export type CurrentUser = { user_id: string; email: string; name: string };

/** The user behind a verified token, or null if their sessions have since been ended. */
export async function loadUser(
  claims: SessionClaims,
): Promise<CurrentUser | null> {
  return withUser(claims.userId, async (client) => {
    const { rows } = await client.query<
      CurrentUser & { token_version: number }
    >(
      "SELECT user_id, email, name, token_version FROM users WHERE user_id = $1",
      [claims.userId],
    );
    const row = rows[0];
    if (!row || row.token_version !== claims.tokenVersion) return null;
    return { user_id: row.user_id, email: row.email, name: row.name };
  });
}

export async function loadMemberships(userId: string): Promise<Membership[]> {
  const { rows } = await pool().query<Membership>(
    "SELECT org_id, name, slug, timezone, role FROM auth_memberships($1)",
    [userId],
  );
  return rows;
}
