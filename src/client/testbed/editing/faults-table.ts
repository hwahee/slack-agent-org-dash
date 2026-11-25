/**
 * The fault-rule editor's table ↔ a core's `faults` (`FaultRule[]`,
 * docs/testbed/faults-and-seed.md §1). Every cell is text while editing; the
 * conversion back says which cell it could not read.
 */
import type { FaultKind } from '@shared/testbed/core';
import type { FaultRule } from '@shared/testbed/faults';

/** The effect column; `delay` has a column of its own. */
export type FaultEffect = '' | Exclude<FaultKind, 'delay'>;

export interface FaultRow {
  id: string;
  /** `key=value, key=value`; a value that reads as JSON (number, true, "quoted") is that. */
  match: string;
  /** `0`–`1`; empty = always. */
  probability: string;
  /** `200`, or a range `100-300`; empty = no delay. */
  delayMs: string;
  effect: FaultEffect;
  /** The error kind when `effect` is `error` (e.g. `http-500`). */
  error: string;
  /** Inactive after this many; empty = no limit. */
  times: string;
}

export interface FaultCellError {
  row: number;
  column: keyof FaultRow;
  message: string;
}

/** A plain string value is written bare unless it would read back as something else. */
function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return JSON.stringify(value);
    } catch {
      return value.includes(',') || value.includes('=') ? JSON.stringify(value) : value;
    }
  }
  return JSON.stringify(value);
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function emptyRow(id: string): FaultRow {
  return { id, match: '', probability: '', delayMs: '', effect: '', error: '', times: '' };
}

export function rulesToRows(rules: readonly FaultRule[]): FaultRow[] {
  return rules.map((rule) => ({
    id: rule.id,
    match: Object.entries(rule.match ?? {})
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(', '),
    probability: rule.probability === undefined ? '' : String(rule.probability),
    delayMs:
      rule.delayMs === undefined
        ? ''
        : typeof rule.delayMs === 'number'
          ? String(rule.delayMs)
          : `${rule.delayMs.min}-${rule.delayMs.max}`,
    effect:
      rule.error !== undefined
        ? 'error'
        : rule.disconnect
          ? 'disconnect'
          : rule.corrupt
            ? 'corrupt'
            : '',
    error: rule.error ?? '',
    times: rule.times === undefined ? '' : String(rule.times),
  }));
}

/** Splits `a=1, b="x,y"` on the commas outside quotes. */
function splitPairs(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

export function rowsToRules(rows: readonly FaultRow[]): {
  rules: FaultRule[];
  errors: FaultCellError[];
} {
  const rules: FaultRule[] = [];
  const errors: FaultCellError[] = [];
  rows.forEach((row, index) => {
    const fail = (column: keyof FaultRow, message: string) =>
      errors.push({ row: index, column, message });
    const rule: FaultRule = { id: row.id.trim() };
    if (rule.id === '') fail('id', 'required');
    else if (rows.slice(0, index).some((other) => other.id.trim() === rule.id))
      fail('id', '같은 id가 위에 있음');

    if (row.match.trim() !== '') {
      const match: Record<string, unknown> = {};
      for (const pair of splitPairs(row.match)) {
        const at = pair.indexOf('=');
        if (at <= 0) {
          fail('match', `"${pair}" is not key=value`);
          continue;
        }
        match[pair.slice(0, at).trim()] = parseValue(pair.slice(at + 1).trim());
      }
      rule.match = match;
    }

    if (row.probability.trim() !== '') {
      const probability = Number(row.probability);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        fail('probability', '0–1');
      } else {
        rule.probability = probability;
      }
    }

    const delay = row.delayMs.trim();
    if (delay !== '') {
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(delay);
      if (range) {
        const [min, max] = [Number(range[1]), Number(range[2])];
        if (min > max) fail('delayMs', '최소값이 최대값보다 큼');
        else rule.delayMs = { min, max };
      } else if (/^\d+$/.test(delay)) {
        rule.delayMs = Number(delay);
      } else {
        fail('delayMs', 'ms or min-max');
      }
    }

    if (row.effect === 'error') {
      if (row.error.trim() === '') fail('error', 'required');
      else rule.error = row.error.trim();
    } else if (row.effect === 'disconnect') {
      rule.disconnect = true;
    } else if (row.effect === 'corrupt') {
      rule.corrupt = true;
    }

    if (row.times.trim() !== '') {
      const times = Number(row.times);
      if (!Number.isInteger(times) || times < 1) fail('times', 'integer ≥ 1');
      else rule.times = times;
    }
    rules.push(rule);
  });
  return { rules, errors };
}

/** Moves row `from` by `by` (−1 up, +1 down), within bounds. */
export function moveRow<T>(rows: readonly T[], from: number, by: -1 | 1): T[] {
  const to = from + by;
  if (to < 0 || to >= rows.length) return [...rows];
  const next = [...rows];
  const [row] = next.splice(from, 1);
  if (row !== undefined) next.splice(to, 0, row);
  return next;
}
