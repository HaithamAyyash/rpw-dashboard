import { errorResponse } from "@/lib/ingest/responses";
import {
  loadMemberships,
  loadUser,
  type CurrentUser,
  type Membership,
} from "./current";
import {
  allowedOrigins,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  shouldReissue,
  signSession,
  verifySession,
} from "./session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionContext = { user: CurrentUser; memberships: Membership[] };
export type OrgContext = SessionContext & { membership: Membership };

/** CSRF check for state-changing requests: browsers send Origin and scripts can't forge it. */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && allowedOrigins().includes(origin);
}

/** Every endpoint that needs a logged-in user goes through here. */
export async function withSession(
  request: Request,
  handler: (context: SessionContext) => Promise<Response>,
): Promise<Response> {
  try {
    const claims = await verifySession(readCookie(request, SESSION_COOKIE));
    const user = claims ? await loadUser(claims) : null;
    if (!claims || !user) {
      return errorResponse(401, "unauthorized", "Not logged in");
    }
    const memberships = await loadMemberships(user.user_id);
    const response = await handler({ user, memberships });
    if (shouldReissue(claims)) {
      response.headers.append(
        "Set-Cookie",
        sessionCookie(await signSession(user.user_id, claims.tokenVersion)),
      );
    }
    return response;
  } catch (error) {
    console.error("request failed", error);
    return errorResponse(500, "server_error", "Something went wrong");
  }
}

/**
 * Every organization endpoint goes through here. Another organization's ID gets the same 404 as
 * one that doesn't exist, so its existence isn't revealed. All data access then goes through
 * withOrg(), which sets row-level security from this checked ID, never from the request body.
 */
export async function withOrgAccess(
  request: Request,
  orgId: string,
  handler: (context: OrgContext) => Promise<Response>,
): Promise<Response> {
  return withSession(request, async (session) => {
    const membership = UUID.test(orgId)
      ? session.memberships.find((m) => m.org_id === orgId)
      : undefined;
    if (!membership) return errorResponse(404, "not_found", "Not found");
    return handler({ ...session, membership });
  });
}

/** The one place roles are checked. 'owner' is the only role for now. */
export function requireRole(context: OrgContext, role: "owner"): boolean {
  return context.membership.role === role;
}
