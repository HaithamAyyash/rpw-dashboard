import { z } from "zod";
import { paginationSchema } from "./pagination";

const instant = z.iso.datetime({ offset: true });
const bigintId = z.string().regex(/^\d{1,18}$/);
export const zone = z.string().max(200).optional();

export const statusEnum = z.enum([
  "healthy",
  "suspected",
  "alert",
  "offline",
  "unknown",
]);

const DAY_MS = 86_400_000;

/** from/to as a validated pair; defaults to the last defaultDays days. */
export function range(
  query: { from?: string; to?: string },
  defaultDays: number,
): [string, string] {
  const to = query.to ?? new Date(Date.now() + 60_000).toISOString();
  const from =
    query.from ?? new Date(Date.now() - defaultDays * DAY_MS).toISOString();
  return [from, to];
}

export const rangeSchema = { from: instant.optional(), to: instant.optional() };

export const alertsQuery = z.object({
  ...rangeSchema,
  severity: z.enum(["critical", "warning", "info"]).optional(),
  acknowledged: z.enum(["true", "false"]).optional(),
  zone,
  ...paginationSchema,
});

export const classificationsQuery = z.object({
  ...rangeSchema,
  node_id: bigintId.optional(),
  label: z.enum(["healthy", "infested"]).optional(),
  min_conf: z.coerce.number().min(0).max(1).optional(),
  sort: z
    .enum(["confidence_desc", "confidence_asc", "time_desc", "tree_asc"])
    .optional(),
  zone,
  ...paginationSchema,
});

export const featuresQuery = z.object({
  ...rangeSchema,
  node_id: bigintId.optional(),
  include: z.literal("mfcc").optional(),
  zone,
  ...paginationSchema,
});

export const BUCKETS = {
  "15m": "15 minutes",
  "1h": "1 hour",
  "6h": "6 hours",
  "1d": "1 day",
} as const;

export const energyQuery = z.object({
  ...rangeSchema,
  bucket: z.enum(["15m", "1h", "6h", "1d"]).default("1h"),
  zone,
});

export const zoneQuery = z.object({ zone });
export const pageQuery = z.object({ zone, ...paginationSchema });
export const noQuery = z.object({});
