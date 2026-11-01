import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

/** Sends visitors with no valid session to /login. Membership is checked in app/[org]/layout. */
export async function proxy(request: NextRequest) {
  const claims = await verifySession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );
  if (claims) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  // Everything except the API (it answers 401 itself), login, invite links and static files.
  matcher: [
    "/((?!api/|login|invite/|_next/|nakhel_logo\\.jpg|favicon\\.ico).*)",
  ],
};
