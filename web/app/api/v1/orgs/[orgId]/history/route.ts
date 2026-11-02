import { limitOffset } from "@/lib/api/pagination";
import { orgGet } from "@/lib/api/route";
import { featuresQuery, range } from "@/lib/api/schemas";
import { featurePage } from "@/lib/api/features";

/** All nodes in the organization, or one with ?node_id=. Never returns the MFCC matrix. */
export const GET = orgGet(featuresQuery, async ({ orgId, input }) =>
  Response.json(
    await featurePage(
      orgId,
      input.node_id ?? null,
      range(input, 7),
      false,
      input.zone,
      limitOffset(input),
      input,
    ),
  ),
);
