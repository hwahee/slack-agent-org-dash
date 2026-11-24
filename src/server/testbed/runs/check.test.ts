import { describe, expect, test } from 'bun:test';

import { ValidationError } from '@shared/validation';

import { EventBus } from '../events/bus';
import { runCheck, type CheckDeps, type CheckExpectation } from './check';
import { createMemoryRunStore } from './memory-store';
import { RunManager } from './runs';

function setup(): CheckDeps {
  const bus = new EventBus();
  const store = createMemoryRunStore();
  return { bus, store, runs: new RunManager(bus, store) };
}

function echo(deps: CheckDeps, n: number) {
  for (let i = 0; i < n; i += 1) {
    deps.bus.emit({
      core: 'sample',
      kind: 'sample.data.echoed',
      actor: 'product',
      summary: `echo ${i}`,
    });
  }
}

const filter = { kind: 'sample.data.echoed' };

describe('check', () => {
  test.each<[CheckExpectation, number, boolean]>([
    [{ count: '==2' }, 2, true],
    [{ count: '==2' }, 3, false],
    [{ count: '>=1' }, 1, true],
    [{ count: '>=1' }, 0, false],
    [{ count: '<=0' }, 0, true],
    [{ count: '<=0' }, 1, false],
    [{ none: true }, 0, true],
    [{ none: true }, 2, false],
    [{}, 1, true],
    [{}, 0, false],
  ])(
    '%j with %d matching → pass %p, and an evaluated event each time',
    async (expectation, n, pass) => {
      const deps = setup();
      echo(deps, n);
      const result = await runCheck(
        deps,
        { filter, expect: expectation, label: 'echoes' },
        { actor: 'agent' },
      );
      expect(result).toMatchObject({ pass, matched: n });
      const evaluated = deps.bus.query({ kind: 'testbed.check.evaluated' });
      expect(evaluated).toHaveLength(1);
      expect(evaluated[0]).toMatchObject({
        core: 'testbed',
        actor: 'agent',
        level: pass ? 'info' : 'warn',
        payload: { label: 'echoes', pass, matched: n },
      });
    },
  );

  test('looks at the open Run only, and its outcomes land in the Run summary', async () => {
    const deps = setup();
    echo(deps, 5); // before the Run: not counted
    await deps.runs.start({ label: 'r' }, { actor: 'ci' });
    echo(deps, 2);
    const result = await runCheck(deps, { filter, expect: { count: '==2' } }, { actor: 'ci' });
    expect(result.pass).toBe(true);
    expect(result.sample.map((event) => event.summary)).toEqual(['echo 0', 'echo 1']);
    const ended = await deps.runs.end({ actor: 'ci' });
    expect(ended?.summary?.checks).toEqual([{ pass: true, matched: 2 }]);
  });

  test('with no open Run: the whole ring buffer; with a runId: that Run', async () => {
    const deps = setup();
    echo(deps, 1);
    const run = await deps.runs.start({ label: 'r' }, { actor: 'ci' });
    echo(deps, 2);
    await deps.runs.end({ actor: 'ci' });
    expect((await runCheck(deps, { filter, expect: {} }, { actor: 'ci' })).matched).toBe(3);
    expect(
      (
        await runCheck(
          deps,
          { filter: { ...filter, runId: run.runId }, expect: {} },
          { actor: 'ci' },
        )
      ).matched,
    ).toBe(2);
  });

  test('the sample holds at most 10 events', async () => {
    const deps = setup();
    echo(deps, 12);
    const result = await runCheck(deps, { filter, expect: {} }, { actor: 'ci' });
    expect(result.matched).toBe(12);
    expect(result.sample).toHaveLength(10);
  });

  test('count and none together, or a malformed count, is a validation error', async () => {
    const deps = setup();
    await expect(
      runCheck(deps, { filter, expect: { count: '==1', none: true } }, { actor: 'ci' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      runCheck(deps, { filter, expect: { count: '>1' } }, { actor: 'ci' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
