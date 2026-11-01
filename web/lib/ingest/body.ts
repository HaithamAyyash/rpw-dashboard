import { MAX_BODY_BYTES } from "@/lib/schemas/ingest";

export type ReadBody =
  { tooLarge: false; text: string } | { tooLarge: true; text: string };

/**
 * Reads at most MAX_BODY_BYTES. Counts the actual stream, because Content-Length can be missing
 * (chunked encoding) or simply untrue. On overflow, returns what was read so far for the reject log.
 */
export async function readLimitedBody(request: Request): Promise<ReadBody> {
  const decoder = new TextDecoder();
  if (!request.body) return { tooLarge: false, text: "" };

  const reader = request.body.getReader();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true, text };
    }
  }
  return { tooLarge: false, text: text + decoder.decode() };
}
