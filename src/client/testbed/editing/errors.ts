/**
 * Sentences for failed calls, in the page's language. The server's messages
 * are written for agents (and validation messages come from the schema
 * library, in English), so the dashboard builds its own from the error
 * `code` and `details`, falling back to the server's message only for codes
 * it does not know.
 */
import type { MessageKey, MessageParams } from '@shared/i18n';

import { ApiRequestError } from '../../api/http';

export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** One validation issue as a 400 `VALIDATION_ERROR` carries it (`ValidationIssue`). */
export interface Issue {
  path?: string;
  message?: string;
  code?: string;
  params?: Record<string, unknown>;
}

/** The validation issues of a failed call; empty for any other failure. */
export function issuesOf(error: unknown): Issue[] {
  if (!(error instanceof ApiRequestError) || error.code !== 'VALIDATION_ERROR') return [];
  const details = error.details;
  return Array.isArray(details) ? (details as Issue[]) : [];
}

/** Codes of our own checks whose sentence needs nothing but the code. */
const PLAIN: Record<string, MessageKey> = {
  unknown_key: 'testbed.issue.unknownConfigKey',
  duplicate_id: 'testbed.issue.duplicateId',
  no_effect: 'testbed.issue.noEffect',
  delay_range: 'testbed.issue.delayRange',
  unsupported_fault: 'testbed.issue.unsupportedFault',
  invalid_json: 'testbed.issue.invalidJson',
  unknown_replica: 'testbed.issue.unknownReplica',
  no_replicas: 'testbed.issue.noReplicas',
};

const TYPES: Record<string, MessageKey> = {
  number: 'testbed.issue.type.number',
  int: 'testbed.issue.type.integer',
  integer: 'testbed.issue.type.integer',
  string: 'testbed.issue.type.string',
  boolean: 'testbed.issue.type.boolean',
  object: 'testbed.issue.type.object',
  array: 'testbed.issue.type.array',
};

const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

function bound(issue: Issue, t: Translate): string | null {
  const params = issue.params ?? {};
  const small = issue.code === 'too_small';
  const value = small ? params.minimum : params.maximum;
  if (typeof value !== 'number') return null;
  const inclusive = params.inclusive !== false;
  if (params.origin === 'string') {
    if (small && value === 1) return t('testbed.issue.empty');
    return t(
      small ? 'testbed.issue.tooShort' : 'testbed.issue.tooLong',
      small ? { min: value } : { max: value },
    );
  }
  if (params.origin === 'array' || params.origin === 'set') {
    return t(
      small ? 'testbed.issue.tooFew' : 'testbed.issue.tooMany',
      small ? { min: value } : { max: value },
    );
  }
  if (small) {
    return t(inclusive ? 'testbed.issue.tooSmall' : 'testbed.issue.tooSmallExclusive', {
      min: value,
    });
  }
  return t(inclusive ? 'testbed.issue.tooBig' : 'testbed.issue.tooBigExclusive', { max: value });
}

/** The sentence for one issue, without its path. */
export function issueText(issue: Issue, t: Translate): string {
  const params = issue.params ?? {};
  const fallback = issue.message ?? issue.code ?? '';
  const plain = issue.code === undefined ? undefined : PLAIN[issue.code];
  if (plain) return t(plain);
  switch (issue.code) {
    case 'too_small':
    case 'too_big':
      return bound(issue, t) ?? fallback;
    case 'invalid_type': {
      if (params.received === 'undefined') return t('testbed.issue.required');
      const expected = typeof params.expected === 'string' ? params.expected : undefined;
      if (expected === undefined) return fallback;
      const key = TYPES[expected];
      return key ? t(key) : t('testbed.issue.type.other', { expected });
    }
    case 'invalid_value':
      return Array.isArray(params.values)
        ? t('testbed.issue.oneOf', { values: params.values.map(show).join(', ') })
        : fallback;
    case 'unrecognized_keys':
      return t('testbed.issue.unknownKey');
    case 'invalid_format':
      return typeof params.format === 'string'
        ? t('testbed.issue.format', { format: params.format })
        : fallback;
    case 'not_multiple_of':
      return typeof params.divisor === 'number'
        ? t('testbed.issue.multipleOf', { divisor: params.divisor })
        : fallback;
    case 'invalid_union':
      return t('testbed.issue.union');
    default:
      return fallback;
  }
}

/** A dotted path as shown to a person; the root is "(whole input)". */
function pathText(path: string | undefined, t: Translate): string {
  return path === undefined || path === '' ? t('testbed.issue.root') : path;
}

/**
 * One `path: sentence` line per issue. An unknown key is reported where it
 * is (`extra: unknown key`), not on the object holding it.
 */
export function issueLines(
  error: unknown,
  t: Translate,
  label: (path: string | undefined) => string = (path) => pathText(path, t),
): string[] {
  return issuesOf(error).flatMap((issue) => {
    const keys = issue.params?.keys;
    if (issue.code === 'unrecognized_keys' && Array.isArray(keys) && keys.length > 0) {
      return keys.map((key) => {
        const path =
          issue.path === undefined || issue.path === '' ? show(key) : `${issue.path}.${show(key)}`;
        return `${label(path)}: ${t('testbed.issue.unknownKey')}`;
      });
    }
    return [`${label(issue.path)}: ${issueText(issue, t)}`];
  });
}

/** Lines to show for a failed call: its validation issues, or one sentence. */
export function errorLines(error: unknown, t: Translate): string[] {
  const lines = issueLines(error, t);
  return lines.length > 0 ? lines : [errorMessage(error, t)];
}

/** The sentence to show for a failed call. */
export function errorMessage(error: unknown, t: Translate): string {
  const lines = issueLines(error, t);
  if (lines.length > 0) return lines.join(' · ');
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Where `JSON.parse` stopped, from its error: browsers say `line 2 column 3`
 * or `position 10`; the sentence itself is the engine's, in English.
 */
export function jsonErrorText(error: unknown, text: string, t: Translate): string {
  const message = error instanceof Error ? error.message : '';
  const lineColumn = /line (\d+) column (\d+)/i.exec(message);
  if (lineColumn) {
    return t('testbed.json.invalidAt', {
      line: Number(lineColumn[1]),
      column: Number(lineColumn[2]),
    });
  }
  const position = /position (\d+)/i.exec(message);
  if (position) {
    const before = text.slice(0, Number(position[1])).split('\n');
    return t('testbed.json.invalidAt', {
      line: before.length,
      column: (before.at(-1)?.length ?? 0) + 1,
    });
  }
  return t('testbed.json.invalid');
}
