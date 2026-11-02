import type { z } from "zod";
import { MAX_AGE_MS, MAX_FUTURE_MS } from "@/lib/schemas/ingest";
import { readLimitedBody } from "./body";
import { errorResponse } from "./responses";
import { authenticateKey, recordReject, type ClusterIdentity } from "./store";

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  return match?.[1] ?? null;
}

export type StoreOutcome = "stored" | "duplicate" | "unknown_node";

/** Auth, size limit, validation, clock checks and rejects: the same for every ingest endpoint. */
export function ingestHandler<S extends z.ZodType<{ timestamp: string }>>(
  schema: S,
  store: (identity: ClusterIdentity, data: z.infer<S>) => Promise<StoreOutcome>,
) {
  return async (request: Request): Promise<Response> => {
    try {
      const key = bearerToken(request);
      const identity = key ? await authenticateKey(key) : null;
      if (!identity) {
        return errorResponse(
          401,
          "unauthorized",
          "Missing, unknown or revoked API key",
        );
      }
      return await handle(request, identity, schema, store);
    } catch (error) {
      // Answers 5xx so the Pi keeps the message and retries; nothing has been lost.
      console.error("ingest failed", error);
      return errorResponse(500, "server_error", "Could not store the message");
    }
  };
}

async function handle<S extends z.ZodType<{ timestamp: string }>>(
  request: Request,
  identity: ClusterIdentity,
  schema: S,
  store: (identity: ClusterIdentity, data: z.infer<S>) => Promise<StoreOutcome>,
): Promise<Response> {
  const body = await readLimitedBody(request);
  if (body.tooLarge) {
    await recordReject(identity, 413, "body_too_large", body.text, null);
    return errorResponse(413, "body_too_large", "Body is larger than 64 KB");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    await recordReject(identity, 400, "invalid_json", body.text, null);
    return errorResponse(400, "invalid_json", "Body is not valid JSON");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    await recordReject(identity, 400, "invalid_body", body.text, parsed);
    return errorResponse(
      400,
      "invalid_body",
      "Body does not match the schema",
      result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  const data = result.data;

  const age = Date.now() - new Date(data.timestamp).getTime();
  if (age < -MAX_FUTURE_MS) {
    await recordReject(identity, 400, "timestamp_in_future", body.text, parsed);
    return errorResponse(
      400,
      "timestamp_in_future",
      "timestamp is more than 10 minutes in the future; check the node and Pi clocks",
    );
  }
  if (age > MAX_AGE_MS) {
    await recordReject(identity, 400, "timestamp_too_old", body.text, parsed);
    return errorResponse(
      400,
      "timestamp_too_old",
      "timestamp is older than the 1-year retention period; check the node and Pi clocks",
    );
  }

  const outcome = await store(identity, data);
  const loraId = (data as { node_id?: number }).node_id;
  if (outcome === "unknown_node") {
    await recordReject(identity, 422, "unknown_node", body.text, parsed);
    return errorResponse(
      422,
      "unknown_node",
      `No active node with LoRa ID ${loraId} is registered under this cluster head`,
    );
  }
  return Response.json(
    {
      status: outcome,
      ...(loraId === undefined ? {} : { node_id: loraId }),
      timestamp: data.timestamp,
      server_time: new Date().toISOString(),
    },
    { status: outcome === "stored" ? 201 : 200 },
  );
}
