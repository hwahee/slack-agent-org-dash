/**
 * Supervision, restarts and replicas (docs/spec.md §11 M12), with the fake
 * core. Timings shortened as the spec says: pings every 1 s with 200 ms to
 * answer, restart backoff from 100 ms, 1 s of running to count as stable.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { TestbedEvent } from '@shared/testbed/events';

import { REPO_ROOT } from '../smoke/load';
import { startTestServer, waitForEvent } from '../testing';
import { defineExternalCore } from './define';

const FAKE = join(REPO_ROOT, 'src/server/testbed/external/fake-core.ts');
const TIMING = { restartBackoffMs: 100, stableMs: 1000 };
const FAST_PING = { pingIntervalMs: 1000, pingTimeoutMs: 200 };
const human = { actor: 'human' as const };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot(env: Record<string, string> = {}) {
  const testbed = await startTestServer({
    cores: [
      defineExternalCore({
        id: 'fake',
        kind: 'passive',
        title: 'Fake',
        command: [process.execPath, FAKE],
      }),
    ],
    env,
    externalTiming: TIMING,
  });
  cleanups.push(testbed.stop);
  const { runtime, plane } = testbed;
  const events = (kind: string): TestbedEvent[] =>
    runtime.bus.buffered().filter((event) => event.kind === kind);
  const replicas = () => runtime.host.status('fake').replicas ?? [];
  /** Waits for the `n`-th event of `kind`. */
  async function nth(kind: string, n: number, timeoutMs = 8000): Promise<TestbedEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events(kind)[n - 1];
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no ${kind} #${n} within ${timeoutMs}ms`);
      await Bun.sleep(20);
    }
  }
  async function until(check: () => boolean, timeoutMs = 8000, what = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(20);
    }
  }
  return { ...testbed, control: plane.control, host: runtime.host, events, replicas, nth, until };
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('supervision', () => {
  test('hang-status: unresponsive → exited → restarting; past maxRestarts it stays in error; start begins again', async () => {
    const { control, host, events, nth, until } = await boot({ FAKE_MODE: 'hang-status' });
    await control.setConfig('fake', { ...FAST_PING, maxRestarts: 2 }, human);

    const started = Date.now();
    await nth('testbed.core.process.unresponsive', 1);
    expect(Date.now() - started).toBeLessThan(4500);
    await nth('testbed.core.process.exited', 1);
    const first = await nth('testbed.core.process.restarting', 1);
    expect(first.payload).toMatchObject({ attempt: 1, waitMs: 100 });
    expect(first).toMatchObject({ core: 'fake', replica: 'r0', actor: 'system' });
    await nth('testbed.core.process.spawned', 2);

    // Two restarts allowed: the third failure leaves it in error.
    await until(
      () => host.status('fake').detail === 'restart limit reached',
      15_000,
      'the restart limit',
    );
    expect(host.status('fake').state).toBe('error');
    expect(events('testbed.core.process.restarting')).toHaveLength(2);
    const spawnedBefore = events('testbed.core.process.spawned').length;
    await Bun.sleep(300);
    expect(events('testbed.core.process.spawned')).toHaveLength(spawnedBefore);

    await control.start('fake', human);
    expect(events('testbed.core.process.spawned')).toHaveLength(spawnedBefore + 1);
    expect(host.status('fake').replicas?.[0]?.restarts).toBe(0);
  }, 30_000);

  test('crash-after-start: exited with code 3 and its stderr, restarted to running, backoff 100 → 200 → 400 ms', async () => {
    const { nth, events } = await boot({ FAKE_MODE: 'crash-after-start' });
    const exited = await nth('testbed.core.process.exited', 1);
    expect(exited.payload).toMatchObject({ code: 3, signal: null });
    expect((exited.payload as { stderr: string[] }).stderr.at(-1)).toBe('crashing on purpose');
    await nth('testbed.core.process.restarting', 3);
    expect(
      events('testbed.core.process.restarting')
        .slice(0, 3)
        .map((event) => (event.payload as { waitMs: number }).waitMs),
    ).toEqual([100, 200, 400]);
    // Between crashes it was running again.
    expect(
      events('testbed.core.state').filter(
        (event) => event.replica === 'r0' && (event.payload as { to: string }).to === 'running',
      ).length,
    ).toBeGreaterThanOrEqual(2);
  }, 15_000);

  test('killed from outside while running: restarted and started again; stable for 1 s → restart count 0', async () => {
    const { host, control, replicas, nth, until } = await boot();
    await control.setConfig('fake', FAST_PING, human);
    const pid = replicas()[0]?.pid;
    expect(alive(pid)).toBe(true);
    process.kill(pid ?? 0, 'SIGKILL');
    await nth('testbed.core.process.exited', 1);
    await nth('testbed.core.process.spawned', 2);
    await until(() => host.status('fake').state === 'running', 5000, 'running again');
    expect(replicas()[0]?.pid).not.toBe(pid);
    expect(replicas()[0]?.restarts).toBe(1);
    await until(() => replicas()[0]?.restarts === 0, 3000, 'the restart count to clear');
  }, 15_000);

  test("restart: 'never' + crash-after-start: stays in error, not spawned again", async () => {
    const { host, events, nth } = await boot({
      FAKE_MODE: 'crash-after-start',
      FAKE_RESTART: 'never',
    });
    await nth('testbed.core.process.exited', 1);
    await Bun.sleep(500);
    expect(host.status('fake').state).toBe('error');
    expect(events('testbed.core.process.restarting')).toHaveLength(0);
    expect(events('testbed.core.process.spawned')).toHaveLength(1);
  });
});

describe('replicas', () => {
  test('3 replicas: 3 processes r0–r2 with their own seeds; counters add up; one killed → not running until back', async () => {
    const { host, control, runtime, replicas, until } = await boot({ FAKE_REPLICAS: '3' });
    const list = replicas();
    expect(list.map((replica) => replica.id)).toEqual(['r0', 'r1', 'r2']);
    expect(new Set(list.map((replica) => replica.pid)).size).toBe(3);
    expect(list.every((replica) => alive(replica.pid))).toBe(true);
    const seed = runtime.runs.bootSeed();
    for (const id of ['r0', 'r1', 'r2']) {
      const seen = (await control.invokeAction('fake', 'seen', {}, human, id)) as {
        seeds: string[];
      };
      expect(seen.seeds[0]).toBe(`${seed}:${id}`);
    }

    await until(
      () => replicas().every((replica) => Object.keys(replica.counters).length > 0),
      8000,
      'counters',
    );
    const status = host.status('fake');
    const summed = (status.replicas ?? []).reduce(
      (sum, replica) => sum + (replica.counters.limit ?? 0),
      0,
    );
    expect(status.counters.limit).toBe(summed);
    expect(status.endpoints.map((endpoint) => endpoint.replica)).toEqual(['r0', 'r1', 'r2']);

    process.kill(list[1]?.pid ?? 0, 'SIGKILL');
    await until(() => host.status('fake').state !== 'running', 3000, 'not running');
    await until(() => host.status('fake').state === 'running', 8000, 'running again');
    expect(replicas()[1]?.pid).not.toBe(list[1]?.pid);
  }, 20_000);

  test('actions: every replica → { r0, r1, r2 }; one replica over REST and MCP; r9 is VALIDATION_ERROR; a slow replica only fails its own slot', async () => {
    const testbed = await boot({ FAKE_REPLICAS: '3', FAKE_MODE_R2: 'slow-action' });
    const { control, base } = testbed;
    await control.setConfig('fake', { requestTimeoutMs: 1000 }, human);

    const all = (await control.invokeAction('fake', 'echo', { text: 'a' }, human)) as Record<
      string,
      unknown
    >;
    expect(all.r0).toEqual({ text: 'a', replica: 'r0' });
    expect(all.r1).toEqual({ text: 'a', replica: 'r1' });
    expect(all.r2).toMatchObject({ error: { code: 'CORE_TIMEOUT' } });

    const rest = await fetch(`${base}/testbed/api/cores/fake/actions/echo?replica=r1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'b' }),
    });
    expect(await rest.json()).toEqual({ text: 'b', replica: 'r1' });

    const nine = await fetch(`${base}/testbed/api/cores/fake/actions/echo?replica=r9`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'b' }),
    });
    expect(nine.status).toBe(400);
    expect(((await nine.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR',
    );

    const transport = new StreamableHTTPClientTransport(new URL('/testbed/mcp', base));
    const client = new Client({ name: 'm12', version: '0.0.0' });
    await client.connect(transport);
    cleanups.push(() => client.close());
    const { tools } = await client.listTools();
    const echo = tools.find((tool) => tool.name === 'fake_echo');
    expect(echo?.inputSchema.properties).toHaveProperty('replica');
    const result = (await client.callTool({
      name: 'fake_echo',
      arguments: { text: 'c', replica: 'r1' },
    })) as { structuredContent?: unknown };
    expect(result.structuredContent).toEqual({ text: 'c', replica: 'r1' });
  }, 20_000);

  test('replicas 3 → 1: restart-required; after stop → start one process, r1 and r2 ended', async () => {
    const { control, replicas } = await boot({ FAKE_REPLICAS: '3' });
    const before = replicas();
    expect(await control.setConfig('fake', { replicas: 1 }, human)).toMatchObject({
      result: 'restart-required',
    });
    expect(replicas()).toHaveLength(3);
    await control.stop('fake', human);
    await control.start('fake', human);
    expect(replicas().map((replica) => replica.id)).toEqual(['r0']);
    expect(replicas()[0]?.state).toBe('running');
    expect(alive(before[0]?.pid)).toBe(true);
    expect(alive(before[1]?.pid)).toBe(false);
    expect(alive(before[2]?.pid)).toBe(false);
  }, 15_000);
});

describe('an unknown replica of an in-proc core', () => {
  test('is a validation error', async () => {
    const { runtime } = await boot();
    await waitForEvent(runtime.bus, (event) => event.kind === 'testbed.core.process.spawned');
    await expect(
      runtime.host.invokeAction('fake', 'echo', { text: 'x' }, human, 'r5'),
    ).rejects.toThrow('no replica r5');
  });
});
