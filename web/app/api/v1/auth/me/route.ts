import { withSession } from "@/lib/auth/guard";

export async function GET(request: Request): Promise<Response> {
  return withSession(request, async ({ user, memberships }) =>
    Response.json({ user, organizations: memberships }),
  );
}
