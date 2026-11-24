import { describe, expect, test } from 'bun:test';

import { FaultDecider, type FaultDecision } from './faults';
import { generateSeed, SeededRng } from './rng';

describe('SeededRng', () => {
  test('the same seed gives the same first 1000 values', () => {
    const a = new SeededRng('seed-42');
    const b = new SeededRng('seed-42');
    const first = Array.from({ length: 1000 }, () => a.next());
    expect(Array.from({ length: 1000 }, () => b.next())).toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  test('a different seed gives a different sequence', () => {
    const a = new SeededRng('seed-42');
    const b = new SeededRng('seed-43');
    expect(Array.from({ length: 10 }, () => a.next())).not.toEqual(
      Array.from({ length: 10 }, () => b.next()),
    );
  });

  test('int stays within both bounds and reaches them', () => {
    const rng = new SeededRng('ints');
    const values = new Set(Array.from({ length: 500 }, () => rng.int(1, 3)));
    expect([...values].sort()).toEqual([1, 2, 3]);
  });

  test('generateSeed gives fresh hex seeds', () => {
    expect(generateSeed()).toMatch(/^[0-9a-f]{12}$/);
    expect(generateSeed()).not.toBe(generateSeed());
  });
});

describe('FaultDecider', () => {
  const rules = [
    { id: 'slow', match: { path: '/slow' }, delayMs: { min: 10, max: 500 } },
    { id: 'flaky', probability: 0.3, error: 'http-500' },
  ];

  function decisions(seed: string): (FaultDecision | null)[] {
    const rng = new SeededRng(seed);
    const decider = new FaultDecider(() => rng);
    decider.setRules(rules);
    return Array.from({ length: 200 }, (_, i) =>
      decider.decide({ path: i % 3 === 0 ? '/slow' : '/x' }),
    );
  }

  test('the same seed and request order give the same decisions', () => {
    const first = decisions('fault-seed');
    expect(decisions('fault-seed')).toEqual(first);
    expect(first.some((decision) => decision?.ruleId === 'flaky')).toBe(true);
    expect(first.some((decision) => decision === null)).toBe(true);
    for (const decision of first.filter((d) => d?.ruleId === 'slow')) {
      expect(decision?.delayMs).toBeGreaterThanOrEqual(10);
      expect(decision?.delayMs).toBeLessThanOrEqual(500);
    }
  });

  test('times: 2 applies twice, then the rule is inactive until reset or new rules', () => {
    const rng = new SeededRng('x');
    const decider = new FaultDecider(() => rng);
    decider.setRules([{ id: 'twice', disconnect: true, times: 2 }]);
    const ids = () => Array.from({ length: 3 }, () => decider.decide({})?.ruleId ?? null);
    expect(ids()).toEqual(['twice', 'twice', null]);
    decider.reset();
    expect(ids()).toEqual(['twice', 'twice', null]);
    decider.setRules([{ id: 'twice', disconnect: true, times: 2 }]);
    expect(decider.decide({})?.ruleId).toBe('twice');
  });

  test('first matching rule only; match needs every key; effects come together', () => {
    const rng = new SeededRng('x');
    const injected: [FaultDecision, string | undefined][] = [];
    const decider = new FaultDecider(
      () => rng,
      (decision, _selector, correlationId) => injected.push([decision, correlationId]),
    );
    decider.setRules([
      { id: 'a', match: { connId: 'c-1', remoteAddress: '10.0.0.1' }, corrupt: true },
      { id: 'b', match: { connId: 'c-1' }, delayMs: 200, disconnect: true },
      { id: 'c', corrupt: true },
    ]);
    expect(decider.decide({ connId: 'c-1', remoteAddress: '10.0.0.2' }, 'c-1')).toEqual({
      ruleId: 'b',
      delayMs: 200,
      disconnect: true,
    });
    expect(decider.decide({ connId: 'c-1', remoteAddress: '10.0.0.1' })?.ruleId).toBe('a');
    expect(decider.decide({ connId: 'c-9' })?.ruleId).toBe('c');
    expect(injected.map(([decision, correlationId]) => [decision.ruleId, correlationId])).toEqual([
      ['b', 'c-1'],
      ['a', undefined],
      ['c', undefined],
    ]);
  });
});
