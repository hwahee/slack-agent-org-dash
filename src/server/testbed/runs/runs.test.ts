import { describe, expect, test } from 'bun:test';

import { TestbedError } from '../errors';
import { EventBus } from '../events/bus';
import { createMemoryRunStore } from './memory-store';
import { RunManager } from './runs';

function setup() {
  const bus = new EventBus({ instanceId: 'boot1' });
  const store = createMemoryRunStore();
  const runs = new RunManager(bus, store);
  return { bus, store, runs };
}

describe('RunManager', () => {
  test('start: run-<n>-<4 chars>, meta recorded, events stamped with the Run id', async () => {
    const { bus, store, runs } = setup();
    const run = await runs.start(
      { label: 't1', seed: 'abc', configSnapshot: { sample: { port: 0 } } },
      { actor: 'ci', leaseId: 'L1' },
    );
    expect(run.runId).toMatch(/^run-1-[0-9a-f]{4}$/);
    expect(run).toMatchObject({
      label: 't1',
      seed: 'abc',
      instanceId: 'boot1',
      configSnapshot: { sample: { port: 0 } },
      openedBy: { actor: 'ci', leaseId: 'L1' },
    });
    const event = bus.emit({ core: 'sample', kind: 'sample.x.y', actor: 'product', summary: 's' });
    expect(event.runId).toBe(run.runId);
    expect((await store.events(run.runId)).map((e) => e.kind)).toEqual([
      'testbed.run.started',
      'sample.x.y',
    ]);
  });

  test('a seed is generated and recorded when none is given', async () => {
    const { runs } = setup();
    const run = await runs.start({ label: 'no seed' }, { actor: 'agent' });
    expect(run.seed).toMatch(/^[0-9a-f]{12}$/);
    expect(runs.rng().seed).toBe(run.seed);
  });

  test('starting while a Run is open → RUN_ACTIVE with the open Run in details', async () => {
    const { runs } = setup();
    const first = await runs.start({ label: 'gw-retry' }, { actor: 'human' });
    let error: unknown;
    try {
      await runs.start({ label: 'second' }, { actor: 'agent' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TestbedError);
    expect((error as TestbedError).code).toBe('RUN_ACTIVE');
    expect((error as TestbedError).details).toEqual({
      runId: first.runId,
      label: 'gw-retry',
      openedBy: { actor: 'human' },
      startedAt: first.startedAt,
    });
    expect(runs.active()?.runId).toBe(first.runId);
  });

  test("endActive: the open Run ends as 'replaced' and a new one opens", async () => {
    const { store, runs } = setup();
    const first = await runs.start({ label: 'a' }, { actor: 'human' });
    const second = await runs.start({ label: 'b', endActive: true }, { actor: 'agent' });
    expect(second.runId).toMatch(/^run-2-/);
    expect(runs.active()?.runId).toBe(second.runId);
    expect(await store.get(first.runId)).toMatchObject({
      endReason: 'replaced',
      endedBy: { actor: 'agent' },
      openedBy: { actor: 'human' },
    });
  });

  test('end: closes with a summary of counts, top errors and checks', async () => {
    const { bus, store, runs } = setup();
    await runs.start({ label: 's' }, { actor: 'ci' });
    for (let i = 0; i < 3; i += 1) {
      bus.emit({
        core: 'sample',
        kind: 'sample.conn.failed',
        level: 'error',
        actor: 'product',
        summary: `fail ${i}`,
      });
    }
    bus.emit({
      core: 'sample',
      kind: 'sample.disk.failed',
      level: 'error',
      actor: 'product',
      summary: 'disk',
    });
    bus.emit({
      core: 'sample',
      kind: 'sample.data.received',
      level: 'debug',
      actor: 'product',
      summary: 'd',
    });
    const ended = await runs.end({ actor: 'human' });

    expect(ended).toMatchObject({ endReason: 'ended', endedBy: { actor: 'human' } });
    expect(ended?.summary?.byKind).toEqual({
      'testbed.run.started': 1,
      'sample.conn.failed': 3,
      'sample.disk.failed': 1,
      'sample.data.received': 1,
      'testbed.run.ended': 1,
    });
    expect(ended?.summary?.byLevel).toEqual({ debug: 1, info: 2, warn: 0, error: 4 });
    expect(ended?.summary?.topErrors).toEqual([
      { kind: 'sample.conn.failed', count: 3, summary: 'fail 0' },
      { kind: 'sample.disk.failed', count: 1, summary: 'disk' },
    ]);
    expect(runs.active()).toBeNull();
    expect(
      bus.emit({ core: 'sample', kind: 'sample.x.y', actor: 'product', summary: 'after' }).runId,
    ).toBeNull();
    expect((await store.list()).map((meta) => meta.endReason)).toEqual(['ended']);
  });

  test('end with no open Run returns null', async () => {
    expect(await setup().runs.end({ actor: 'ci' })).toBeNull();
  });
});

describe('memory store retention', () => {
  test('keeps only the latest N closed Runs', async () => {
    const bus = new EventBus();
    const store = createMemoryRunStore(2);
    let tick = 0;
    const runs = new RunManager(bus, store, {
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString() as never,
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await runs.start({ label: `r${i}` }, { actor: 'ci' })).runId);
      await runs.end({ actor: 'ci' });
    }
    expect((await store.list()).map((meta) => meta.runId)).toEqual(ids.slice(1).reverse());
  });
});
