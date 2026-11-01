import { z } from "zod";

export const MFCC_FRAMES = 30;
export const MFCC_COEFFS = 13;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_FUTURE_MS = 10 * 60 * 1000;
export const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// The largest magnitude a Postgres `real` can hold. Beyond this the insert would fail with a
// database error, which the Pi would treat as a 5xx and retry forever.
const REAL_MAX = 3.4e38;
const finiteReal = z.number().min(-REAL_MAX).max(REAL_MAX);

// offset: true requires a time zone (Z or +04:00). A bare date or local time is rejected.
const isoInstant = z.iso.datetime({ offset: true });

/** Source of truth for the request body; docs/contracts/measurement.schema.json is generated. */
export const measurementSchema = z.object({
  node_id: z
    .number()
    .int()
    .min(0)
    .max(65535)
    .describe(
      "The node's 2-byte LoRa ID; unique only within this cluster head",
    ),
  timestamp: isoInstant.describe(
    "When the node recorded the sample, ISO 8601 with a time zone",
  ),
  mfcc: z
    .array(z.array(finiteReal).length(MFCC_COEFFS))
    .length(MFCC_FRAMES)
    .describe("30 rows (frames) of 13 numbers (coefficients)"),
  msg_id: z
    .uuid()
    .optional()
    .describe("ID of the row in the Pi's SQLite buffer"),
  received_at: isoInstant
    .optional()
    .describe("When the Pi received the LoRa packet"),
  snr_db: finiteReal.optional().describe("Signal-to-noise ratio in dB"),
  rssi_dbm: z
    .number()
    .int()
    .min(-200)
    .max(20)
    .optional()
    .describe("Received signal strength in dBm"),
  schema_version: z
    .number()
    .int()
    .min(1)
    .max(32767)
    .optional()
    .describe("Payload version; defaults to 1"),
});

export type Measurement = z.infer<typeof measurementSchema>;
