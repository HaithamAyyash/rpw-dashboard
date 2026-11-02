import { z } from "zod";
import { queryParams } from "@/lib/api/pagination";
import {
  originAllowed,
  requireRole,
  withOrgAccess,
  type OrgContext,
} from "@/lib/auth/guard";
import { errorResponse } from "@/lib/ingest/responses";

type RouteContext = { params: Promise<Record<string, string>> };

type Args<Q> = {
  orgId: string;
  input: Q;
  params: Record<string, string>;
  context: OrgContext;
  request: Request;
};

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const BIGINT_ID = /^\d{1,18}$/;

/** bigint IDs from a URL. A bad one is treated like one that doesn't exist. */
export function isBigintId(value: string | undefined): value is string {
  return value !== undefined && BIGINT_ID.test(value);
}

export function notFound(): Response {
  return errorResponse(404, "not_found", "Not found");
}

/** A read endpoint for an organization. schema validates the query string. */
export function orgGet<S extends z.ZodType>(
  schema: S,
  handler: (args: Args<z.infer<S>>) => Promise<Response>,
) {
  return async (
    request: Request,
    { params }: RouteContext,
  ): Promise<Response> => {
    const resolved = await params;
    const orgId = resolved.orgId ?? "";
    return withOrgAccess(request, orgId, async (context) => {
      const parsed = schema.safeParse(queryParams(request));
      if (!parsed.success) {
        return errorResponse(
          400,
          "invalid_query",
          "Bad query parameters",
          issues(parsed.error),
        );
      }
      return handler({
        orgId,
        input: parsed.data,
        params: resolved,
        context,
        request,
      });
    });
  };
}

/** A state-changing endpoint: origin check, owner role, JSON body, friendly database errors. */
export function orgWrite<S extends z.ZodType>(
  schema: S,
  handler: (args: Args<z.infer<S>>) => Promise<Response>,
) {
  return async (
    request: Request,
    { params }: RouteContext,
  ): Promise<Response> => {
    if (!originAllowed(request)) {
      return errorResponse(403, "bad_origin", "Request origin not allowed");
    }
    const resolved = await params;
    const orgId = resolved.orgId ?? "";
    return withOrgAccess(request, orgId, async (context) => {
      if (!requireRole(context, "owner")) {
        return errorResponse(403, "forbidden", "Only owners can do this");
      }
      const text = await request.text();
      if (text.length > MAX_JSON_BYTES) {
        return errorResponse(413, "body_too_large", "Body is too large");
      }
      let body: unknown = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          return errorResponse(400, "invalid_json", "Body is not valid JSON");
        }
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(
          400,
          "invalid_body",
          "Please check the values",
          issues(parsed.error),
        );
      }
      try {
        return await handler({
          orgId,
          input: parsed.data,
          params: resolved,
          context,
          request,
        });
      } catch (error) {
        const friendly = databaseErrorResponse(error);
        if (friendly) return friendly;
        throw error;
      }
    });
  };
}

function issues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
  }));
}

/** Rules the database enforces become answers the UI can show. */
export function databaseErrorResponse(error: unknown): Response | null {
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (constraint === "last_owner") {
    return errorResponse(
      409,
      "last_owner",
      "An organization must keep at least one owner",
    );
  }
  if (code === "23505") {
    return errorResponse(409, "conflict", "That value is already in use");
  }
  if (code === "23514" || code === "23503" || code?.startsWith("22")) {
    return errorResponse(400, "invalid_value", "That value isn't allowed");
  }
  return null;
}
