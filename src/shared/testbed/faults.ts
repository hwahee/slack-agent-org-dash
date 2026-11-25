/**
 * The common fault-injection rule (docs/testbed/faults-and-seed.md §1) and
 * its validator, for core config schemas (`faults: s.array(faultRuleSchema)`).
 */
import { s, type ValidationIssue } from '@shared/validation';

export const faultRuleSchema = s.object({
  id: s.string().check(s.minLength(1)),
  match: s.optional(s.record(s.string(), s.unknown())),
  probability: s.optional(s.number().check(s.gte(0), s.lte(1))),
  delayMs: s.optional(
    s.union([
      s.int().check(s.gte(0)),
      s.object({ min: s.int().check(s.gte(0)), max: s.int().check(s.gte(0)) }),
    ]),
  ),
  error: s.optional(s.string().check(s.minLength(1))),
  disconnect: s.optional(s.boolean()),
  corrupt: s.optional(s.boolean()),
  times: s.optional(s.int().check(s.gte(1))),
});

export interface FaultRule {
  id: string;
  /** Core-specific selector; every key must equal the request's. Absent = every request. */
  match?: Record<string, unknown>;
  /** 0..1, default 1. */
  probability?: number;
  delayMs?: number | { min: number; max: number };
  /** An error kind the core declared (e.g. `http-500`). */
  error?: string;
  disconnect?: boolean;
  corrupt?: boolean;
  /** Inactive after applying this many times. */
  times?: number;
}

/**
 * What the schema cannot say about a core's `faults` list, checked by both
 * hosts (in-proc and external) on every config: ids are unique (events and
 * checks tell rules apart by id), every rule does something (a delay or an
 * effect), and a delay range must not run backwards.
 */
export function faultRulesIssues(rules: readonly FaultRule[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Map<string, number>();
  rules.forEach((rule, index) => {
    const first = seen.get(rule.id);
    if (first === undefined) {
      seen.set(rule.id, index);
    } else {
      issues.push({
        path: `faults.${index}.id`,
        message: `id가 '${rule.id}'인 규칙이 faults.${first}에도 있음. id는 규칙마다 달라야 함`,
        code: 'duplicate_id',
      });
    }
    const delay = rule.delayMs;
    if (delay === undefined && rule.error === undefined && !rule.disconnect && !rule.corrupt) {
      issues.push({
        path: `faults.${index}`,
        message: `규칙 '${rule.id}'에 효과(error·disconnect·corrupt)도 delayMs도 없음. 아무 일도 하지 않는 규칙`,
        code: 'no_effect',
      });
    }
    if (typeof delay === 'object' && delay.min > delay.max) {
      issues.push({
        path: `faults.${index}.delayMs`,
        message: `delayMs 범위의 최소값(${delay.min})이 최대값(${delay.max})보다 큼`,
        code: 'delay_range',
      });
    }
  });
  return issues;
}
