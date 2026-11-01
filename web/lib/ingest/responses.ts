export type ErrorCode =
  | "unauthorized"
  | "invalid_json"
  | "invalid_body"
  | "timestamp_in_future"
  | "timestamp_too_old"
  | "unknown_node"
  | "body_too_large"
  | "server_error"
  | "not_found"
  | "invalid_query"
  | "invalid_credentials"
  | "bad_origin";

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): Response {
  return Response.json(
    {
      error: { code, message, ...(details === undefined ? {} : { details }) },
      server_time: new Date().toISOString(),
    },
    { status },
  );
}
