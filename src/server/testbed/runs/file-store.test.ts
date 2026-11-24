import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { TestbedEvent } from '@shared/testbed/events';
import type { UtcIsoString } from '@shared/time';

import { EventBus } from '../events/bus';
import { openFileRunStore } from './file-store';
import { RunManager } from './runs';

let dataDir: string;
let tick = 0;
/** One second later on every call, so end times order the Runs. */
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString() as UtcIsoString;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'testbed-runs-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('file run store', () => {
  test('a Run a restart left open is closed as restart, its events readable as JSONL', async () => {
    // First boot: open a Run, emit, and "crash" without ending it.
    const bus1 = new EventBus({ instanceId: 'boot1' });
    const store1 = await openFileRunStore({ dataDir, now });
    const runs1 = new RunManager(bus1, store1, { now });
    const run = await runs1.start({ label: 'crashy' }, { actor: 'agent', sessionId: 's-1' });
    bus1.emit({ core: 'sample', kind: 'sample.data.echoed', actor: 'product', summary: 'echo 1' });
    bus1.emit({
      core: 'sample',
      kind: 'sample.data.failed',
      level: 'error',
      actor: 'product',
      summary: 'oops',
    });
    // Reading flushes the batched appends — as the batch timer would before a real crash.
    expect(await store1.events(run.runId)).toHaveLength(3);

    // Second boot: a new store over the same directory.
    const store2 = await openFileRunStore({ dataDir, now });
    const meta = await store2.get(run.runId);
    expect(meta).toMatchObject({
      runId: run.runId,
      instanceId: 'boot1',
      endReason: 'restart',
      endedBy: { actor: 'system' },
      openedBy: { actor: 'agent', sessionId: 's-1' },
    });
    expect(meta?.endedAt).toBeString();
    expect(meta?.summary?.byKind).toEqual({
      'testbed.run.started': 1,
      'sample.data.echoed': 1,
      'sample.data.failed': 1,
    });

    const jsonl = await readFile(join(dataDir, 'runs', `${run.runId}.jsonl`), 'utf8');
    const lines = jsonl.trimEnd().split('\n');
    const events = lines.map((line) => JSON.parse(line) as TestbedEvent);
    expect(events.map((event) => event.id)).toEqual(['boot1:0', 'boot1:1', 'boot1:2']);
    expect(await store2.events(run.runId)).toEqual(events);
  });

  test('closing writes final meta; events written in batches are all there', async () => {
    const bus = new EventBus({ instanceId: 'b' });
    const store = await openFileRunStore({ dataDir, now });
    const runs = new RunManager(bus, store, { now });
    const run = await runs.start({ label: 'many' }, { actor: 'ci' });
    for (let i = 0; i < 100; i += 1) {
      bus.emit({ core: 'sample', kind: 'sample.data.echoed', actor: 'product', summary: `#${i}` });
    }
    await runs.end({ actor: 'ci' });

    const meta = JSON.parse(
      await readFile(join(dataDir, 'runs', `${run.runId}.meta.json`), 'utf8'),
    ) as { endReason: string; summary: { byKind: Record<string, number> } };
    expect(meta.endReason).toBe('ended');
    expect(meta.summary.byKind['sample.data.echoed']).toBe(100);
    expect(await store.events(run.runId)).toHaveLength(102);
  });

  test('retention 3: closing a 4th Run deletes the one closed longest ago', async () => {
    const bus = new EventBus();
    const store = await openFileRunStore({ dataDir, retention: 3, now });
    const runs = new RunManager(bus, store, { now });
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push((await runs.start({ label: `r${i}` }, { actor: 'ci' })).runId);
      await runs.end({ actor: 'ci' });
    }
    expect((await store.list()).map((meta) => meta.runId)).toEqual(ids.slice(1).reverse());
    const files = await readdir(join(dataDir, 'runs'));
    expect(files.some((file) => file.startsWith(`${ids[0]}.`))).toBe(false);
    expect(files.filter((file) => file.endsWith('.meta.json'))).toHaveLength(3);
  });
});
