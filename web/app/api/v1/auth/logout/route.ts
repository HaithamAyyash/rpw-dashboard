import { originAllowed } from "@/lib/auth/guard";
import { clearedSessionCookie } from "@/lib/auth/session";
import { errorResponse } from "@/lib/ingest/responses";

export async function POST(request: Request): Promise<Response> {
  if (!originAllowed(request)) {
    return errorResponse(403, "bad_origin", "Request origin not allowed");
  }
  const response = Response.json({ status: "logged_out" });
  response.headers.append("Set-Cookie", clearedSessionCookie());
  return response;
}
