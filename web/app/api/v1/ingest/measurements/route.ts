import { readLimitedBody } from "@/lib/ingest/body";
import { errorResponse } from "@/lib/ingest/responses";
import {
  authenticateKey,
  recordReject,
  storeMeasurement,
  type ClusterIdentity,
} from "@/lib/ingest/store";
import {
  MAX_AGE_MS,
  MAX_FUTURE_MS,
  measurementSchema,
} from "@/lib/schemas/ingest";

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  return match?.[1] ?? null;
}

/** POST /api/v1/ingest/measurements. Contract: docs/contracts/cluster_head_to_cloud.md */
export async function POST(request: Request): Promise<Response> {
  try {
    const key = bearerToken(request);
    const identity: ClusterIdentity | null = key
      ? await authenticateKey(key)
      : null;
    if (!identity) {
      return errorResponse(
        401,
        "unauthorized",
        "Missing, unknown or revoked API key",
      );
    }
    return await handle(request, identity);
  } catch (error) {
    // Answers 5xx so the Pi keeps the message and retries; nothing has been lost.
    console.error("ingest failed", error);
    return errorResponse(
      500,
      "server_error",
      "Could not store the measurement",
    );
  }
}

async function handle(
  request: Request,
  identity: ClusterIdentity,
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

  const result = measurementSchema.safeParse(parsed);
  if (!result.success) {
    await recordReject(identity, 400, "invalid_body", body.text, parsed);
    return errorResponse(
      400,
      "invalid_body",
      "Body does not match the measurement schema",
      result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  const measurement = result.data;

  const age = Date.now() - new Date(measurement.timestamp).getTime();
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

  const outcome = await storeMeasurement(identity, measurement);
  if (outcome === "unknown_node") {
    await recordReject(identity, 422, "unknown_node", body.text, parsed);
    return errorResponse(
      422,
      "unknown_node",
      `No active node with LoRa ID ${measurement.node_id} is registered under this cluster head`,
    );
  }

  return Response.json(
    {
      status: outcome,
      node_id: measurement.node_id,
      timestamp: measurement.timestamp,
      server_time: new Date().toISOString(),
    },
    { status: outcome === "stored" ? 201 : 200 },
  );
}
