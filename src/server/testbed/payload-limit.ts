/**
 * Payload size cap (docs/testbed/events.md §4, `TESTBED_MAX_PAYLOAD_BYTES`).
 *
 * A payload whose JSON is over the cap is replaced by
 * `{ preview, bytes }`: `preview` is the front of the original JSON (cut on
 * a character boundary so the whole replacement fits the cap) and `bytes` the
 * original size. The event then carries `truncated: true`.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 16_384;

export interface TruncatedPayload {
  preview: string;
  bytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** The longest prefix of `text` that is at most `maxBytes` bytes of UTF-8. */
function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  // A cut inside a multi-byte character decodes to U+FFFD at the end; drop it.
  return decoder.decode(bytes.subarray(0, Math.max(0, maxBytes))).replace(/�$/, '');
}

export function limitPayload(
  payload: unknown,
  maxBytes: number = DEFAULT_MAX_PAYLOAD_BYTES,
): { payload: unknown; truncated: boolean } {
  const json = JSON.stringify(payload) ?? 'null';
  const bytes = byteLength(json);
  if (bytes <= maxBytes) return { payload, truncated: false };

  // Escaping inside the preview string can grow it, so shrink until it fits.
  let budget = maxBytes - byteLength(JSON.stringify({ preview: '', bytes }));
  for (;;) {
    const limited: TruncatedPayload = { preview: utf8Prefix(json, budget), bytes };
    const over = byteLength(JSON.stringify(limited)) - maxBytes;
    if (over <= 0) return { payload: limited, truncated: true };
    budget -= over;
  }
}
