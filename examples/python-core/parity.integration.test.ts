/**
 * The Python SeededRng and FaultDecider give the same values as Bun's for the
 * same seed (docs/testbed/external-core-protocol.md §9, docs/spec.md §11 M13).
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';

import type { FaultRule } from '@shared/testbed/faults';

import { FaultDecider, type FaultDecision } from '../../src/server/testbed/faults';
import { SeededRng } from '../../src/server/testbed/rng';
import { describePython } from './python';

const SEEDS = ['', 'hello-seed', '한글 시드 ✓', 'x7'.repeat(32), 'abc:r1'];
const COUNT = 1000;

const RULES: FaultRule[] = [
  { id: 'c1-twice', match: { connId: 'c-1' }, times: 2, disconnect: true },
  { id: 'third', probability: 0.3, delayMs: { min: 5, max: 50 } },
  { id: 'c2-half', match: { connId: 'c-2' }, probability: 0.5, corrupt: true, times: 10 },
  { id: 'fixed', probability: 0.6, delayMs: 7, error: 'boom' },
  { id: 'range', delayMs: { min: 0, max: 1000 }, times: 15 },
];

const SELECTORS = Array.from({ length: 100 }, (_, i) => ({ connId: `c-${(i % 4) + 1}` }));

async function python(request: unknown): Promise<{
  rng: Record<string, { next: number[]; int: number[] }>;
  decisions: (FaultDecision | null)[];
}> {
  const child = Bun.spawn(['python3', join(import.meta.dir, 'tests/parity_dump.py')], {
    stdin: new Blob([JSON.stringify(request)]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`parity_dump.py exited with ${code}: ${err}`);
  return JSON.parse(out) as Awaited<ReturnType<typeof python>>;
}

describePython('Bun and Python agree', () => {
  test('SeededRng: next() and int(0, 999), first 1000 of 5 seeds; FaultDecider: 100 decisions', async () => {
    const faultSeed = 'faults:r0';
    const out = await python({
      seeds: SEEDS,
      count: COUNT,
      faultSeed,
      rules: RULES,
      selectors: SELECTORS,
    });

    for (const seed of SEEDS) {
      const floats = new SeededRng(seed);
      const ints = new SeededRng(seed);
      const next = Array.from({ length: COUNT }, () => floats.next());
      const int = Array.from({ length: COUNT }, () => ints.int(0, 999));
      expect(out.rng[seed]?.next).toEqual(next);
      expect(out.rng[seed]?.int).toEqual(int);
    }

    const rng = new SeededRng(faultSeed);
    const decider = new FaultDecider(() => rng);
    decider.setRules(RULES);
    const bun = SELECTORS.map((selector) => decider.decide(selector));
    const order = (decisions: (FaultDecision | null)[]) =>
      decisions.map((decision) => (decision ? [decision.ruleId, decision.delayMs ?? null] : null));
    expect(order(out.decisions)).toEqual(order(bun));
    expect(out.decisions).toEqual(bun);
    // The rules are mixed enough that every one is used and some requests pass untouched.
    const used = new Set(bun.map((decision) => decision?.ruleId ?? 'none'));
    expect([...used].sort()).toEqual(['c1-twice', 'c2-half', 'fixed', 'none', 'range', 'third']);
  });
});
