import type { PoolClient } from "pg";
import { pool } from "./pool";

/**
 * Runs fn in one transaction acting for one organization. This is the only way the app touches
 * tenant tables: row-level security returns nothing unless app.current_org is set.
 * set_config(..., true) is SET LOCAL in a form that accepts a parameter.
 */
export async function withOrg<T>(
  orgId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withContext({ orgId }, fn);
}

/** Acting for a signed-in user, before any organization is chosen (their own users row). */
export async function withUser<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withContext({ userId }, fn);
}

async function withContext<T>(
  context: { orgId?: string; userId?: string },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.current_org', $1, true), set_config('app.current_user_id', $2, true)",
      [context.orgId ?? "", context.userId ?? ""],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
