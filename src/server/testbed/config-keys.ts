/** Config patches name only keys the core's config has. */
import type { ValidationIssue } from '@shared/validation';

/**
 * A patch key the config does not have is an error, never dropped quietly:
 * `{ eventLevl: 'debug' }` must not answer `applied` while changing nothing.
 */
export function unknownConfigKeys(
  patch: Record<string, unknown>,
  known: readonly string[],
): ValidationIssue[] {
  return Object.keys(patch)
    .filter((key) => !known.includes(key))
    .map((key) => ({
      path: key,
      message: `알 수 없는 설정 키 '${key}'. 있는 키: ${known.join(', ')}`,
      code: 'unknown_key',
    }));
}

/** The top-level property names of a config schema. */
export function schemaKeys(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  return typeof properties === 'object' && properties !== null ? Object.keys(properties) : [];
}
