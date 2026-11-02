import { limitOffset } from "@/lib/api/pagination";
import { isBigintId, notFound, orgGet } from "@/lib/api/route";
import { featuresQuery, range } from "@/lib/api/schemas";
import { featurePage } from "@/lib/api/features";

export const GET = orgGet(featuresQuery, async ({ orgId, input, params }) => {
  if (!isBigintId(params.nodeId)) return notFound();
  return Response.json(
    await featurePage(
      orgId,
      params.nodeId,
      range(input, 7),
      input.include === "mfcc",
      input.zone,
      limitOffset(input),
      input,
    ),
  );
});
