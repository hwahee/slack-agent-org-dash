/**
 * The common secret-masking utility (docs/testbed/events.md §4).
 *
 * Masks `Authorization`, `Cookie`, `Set-Cookie`, and any key that ends in
 * `-key` or contains `token`, `secret` or `password` (case-insensitive), at
 * any depth. A masked value keeps only enough to tell values apart:
 * `<first 4 chars>…(len <n>, sha256:<first 12 hex>)`. Cores that need more
 * keys pass them in `extraKeys` rather than masking by hand.
 */
import { createHash } from 'node:crypto';

const EXACT_KEYS = new Set(['authorization', 'cookie', 'set-cookie']);
const CONTAINS = ['token', 'secret', 'password'];

function isSecretKey(key: string, extraKeys: ReadonlySet<string>): boolean {
  const lower = key.toLowerCase();
  return (
    EXACT_KEYS.has(lower) ||
    extraKeys.has(lower) ||
    lower.endsWith('-key') ||
    CONTAINS.some((word) => lower.includes(word))
  );
}

/** `sk-a…(len 51, sha256:3f9a0c1d22be)` */
export function maskSecret(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${[...value].slice(0, 4).join('')}…(len ${value.length}, sha256:${digest})`;
}

function maskAny(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskAny);
  if (value === null || value === undefined) return value;
  return maskSecret(typeof value === 'string' ? value : JSON.stringify(value));
}

/** A deep copy of `value` with every secret field masked. */
export function redact(value: unknown, extraKeys: readonly string[] = []): unknown {
  const extra = new Set(extraKeys.map((key) => key.toLowerCase()));
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [
        key,
        isSecretKey(key, extra) ? maskAny(child) : walk(child),
      ]),
    );
  };
  return walk(value);
}

/**
 * `key: value` / `key=value` in a line of text (an external core's stderr)
 * whose key is a secret one → the value masked like {@link maskSecret}.
 * `Authorization: Bearer abc…` keeps `Authorization: ` and masks the rest of
 * the value (up to `,` `;` `"` or the end of the line).
 */
const SECRET_IN_TEXT =
  /\b(authorization|cookie|set-cookie|[\w-]*-key|[\w-]*(?:token|secret|password)[\w-]*)(\s*[:=]\s*)([^\r\n,;"]+)/gi;

export function redactText(line: string): string {
  return line.replace(SECRET_IN_TEXT, (_match, key: string, separator: string, value: string) => {
    const trimmed = value.trim();
    return trimmed === ''
      ? `${key}${separator}${value}`
      : `${key}${separator}${maskSecret(trimmed)}`;
  });
}
