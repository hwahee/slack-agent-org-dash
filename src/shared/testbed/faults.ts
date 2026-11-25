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
 * hosts (in-proc and external) on every config: a delay range must not run
 * backwards.
 */
export function faultRulesIssues(rules: readonly FaultRule[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  rules.forEach((rule, index) => {
    const delay = rule.delayMs;
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
