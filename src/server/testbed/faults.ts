/**
 * The fault-decision helper cores get as `ctx.faults`
 * (docs/testbed/faults-and-seed.md §1).
 *
 * Rules are checked in order; the first whose `match` fits the selector and
 * whose `probability` roll passes is the one applied. A rule with `times`
 * goes inactive after that many applications; `reset()` and `setRules()`
 * start the counts over. Every roll uses the given `SeededRng`, so the same
 * seed and the same request order give the same decisions.
 */
import type { FaultRule } from '@shared/testbed/faults';

import type { SeededRng } from './rng';

export interface FaultDecision {
  ruleId: string;
  delayMs?: number;
  error?: string;
  disconnect?: boolean;
  corrupt?: boolean;
}

/** Called for every decision that applies a rule — the `testbed.fault.injected` hook. */
export type FaultInjectedHandler = (
  decision: FaultDecision,
  selector: Record<string, unknown>,
  correlationId: string | undefined,
) => void;

function matches(rule: FaultRule, selector: Record<string, unknown>): boolean {
  if (!rule.match) return true;
  return Object.entries(rule.match).every(([key, value]) => selector[key] === value);
}

export class FaultDecider {
  private rules: readonly FaultRule[] = [];
  private applied = new Map<string, number>();

  constructor(
    private readonly rng: () => SeededRng,
    private readonly onInjected?: FaultInjectedHandler,
  ) {}

  setRules(rules: readonly FaultRule[]): void {
    this.rules = rules;
    this.applied.clear();
  }

  /** Forgets how often each rule was applied (`times` starts over). */
  reset(): void {
    this.applied.clear();
  }

  decide(selector: Record<string, unknown>, correlationId?: string): FaultDecision | null {
    for (const rule of this.rules) {
      const count = this.applied.get(rule.id) ?? 0;
      if (rule.times !== undefined && count >= rule.times) continue;
      if (!matches(rule, selector)) continue;
      const probability = rule.probability ?? 1;
      if (probability < 1 && this.rng().next() >= probability) continue;

      this.applied.set(rule.id, count + 1);
      const decision: FaultDecision = { ruleId: rule.id };
      if (rule.delayMs !== undefined) {
        decision.delayMs =
          typeof rule.delayMs === 'number'
            ? rule.delayMs
            : this.rng().int(rule.delayMs.min, rule.delayMs.max);
      }
      if (rule.error !== undefined) decision.error = rule.error;
      if (rule.disconnect) decision.disconnect = true;
      if (rule.corrupt) decision.corrupt = true;
      this.onInjected?.(decision, selector, correlationId);
      return decision;
    }
    return null;
  }
}
