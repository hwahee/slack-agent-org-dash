/**
 * py-echo turned on the way a testbed turns it on (docs/spec.md §11 M13):
 * `TESTBED_EXAMPLE_CORES=py-echo PY_ECHO_PORT=0 PY_ECHO_REPLICAS=2`.
 */
import { afterEach, expect, test } from 'bun:test';

import type { TestbedEvent } from '@shared/testbed/events';

import { startTestServer, TcpClient, waitForEvent } from '../../src/server/testbed/testing';
import { describePython } from './python';

const human = { actor: 'human' as const };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot(replicas: number) {
  const testbed = await startTestServer({
    env: {
      TESTBED_EXAMPLE_CORES: 'py-echo',
      PY_ECHO_PORT: '0',
      PY_ECHO_REPLICAS: String(replicas),
    },
    externalTiming: { restartBackoffMs: 100, stableMs: 1000 },
  });
  cleanups.push(testbed.stop);
  const { runtime, plane } = testbed;
  const status = () => runtime.host.status('py-echo');
  const events = (kind: string): TestbedEvent[] =>
    runtime.bus.buffered().filter((event) => event.kind === kind);
  async function connect(url: string): Promise<TcpClient> {
    const client = await TcpClient.connect(url);
    cleanups.push(() => client.close());
    return client;
  }
  async function until(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(20);
    }
  }
  return { ...testbed, control: plane.control, status, events, connect, until };
}

describePython('py-echo', () => {
  test('2 replicas: running, an endpoint each, echo on both, events per replica, disconnect fault, killed → back', async () => {
    const { control, status, events, connect, until, runtime } = await boot(2);
    const manifest = control.getManifest(human);
    expect(manifest.cores.find((core) => core.id === 'py-echo')).toMatchObject({
      external: true,
      replicas: 2,
      kind: 'passive',
    });

    // Each replica's endpoints arrive with its first status answer.
    await until(() => status().endpoints.length === 2, 'both endpoints');
    const now = status();
    expect(now.state).toBe('running');
    expect(now.replicas?.map((replica) => [replica.id, replica.state])).toEqual([
      ['r0', 'running'],
      ['r1', 'running'],
    ]);
    expect(now.endpoints.map((endpoint) => [endpoint.name, endpoint.replica])).toEqual([
      ['echo', 'r0'],
      ['echo', 'r1'],
    ]);
    const ports = new Set(
      now.endpoints.map((endpoint) => new URL(endpoint.url.replace(/^tcp:/, 'http:')).port),
    );
    expect(ports.size).toBe(2);

    for (const [index, endpoint] of now.endpoints.entries()) {
      const client = await connect(endpoint.url);
      const sent = new Uint8Array([index, 0, 255, 7, 42]);
      client.send(sent);
      expect(await client.receive(sent.byteLength)).toEqual(sent);
    }
    await until(() => events('py-echo.data.echoed').length === 2, 'two echoes');
    expect(
      events('py-echo.data.echoed')
        .map((event) => event.replica)
        .sort(),
    ).toEqual(['r0', 'r1']);
    expect(events('py-echo.data.echoed').every((event) => event.core === 'py-echo')).toBe(true);

    await control.setConfig(
      'py-echo',
      { faults: [{ id: 'cut', disconnect: true, times: 1 }] },
      human,
    );
    const r0 = now.endpoints[0]?.url ?? '';
    const cut = await connect(r0);
    cut.send('bye');
    await cut.closed;
    const injected = await waitForEvent(
      runtime.bus,
      (event) => event.kind === 'testbed.fault.injected' && event.replica === 'r0',
    );
    expect(injected.payload).toMatchObject({
      core: 'py-echo',
      ruleId: 'cut',
      effects: { disconnect: true },
    });

    // A restarted process gets the rules again with fresh counts, so clear them first.
    await control.setConfig('py-echo', { faults: [] }, human);
    const pid = now.replicas?.[0]?.pid ?? 0;
    process.kill(pid, 'SIGKILL');
    await waitForEvent(
      runtime.bus,
      (event) => event.kind === 'testbed.core.process.exited' && event.replica === 'r0',
      5000,
    );
    await until(
      () =>
        status().state === 'running' &&
        status().replicas?.[0]?.pid !== pid &&
        status().endpoints.some((endpoint) => endpoint.replica === 'r0' && endpoint.url !== r0),
      'r0 restarted on a new port',
    );
    const again = status().endpoints.find((endpoint) => endpoint.replica === 'r0')?.url ?? '';
    const client = await connect(again);
    client.send('again');
    expect(new TextDecoder().decode(await client.receive(5))).toBe('again');
  }, 30_000);

  test('the same Run seed with a probability 0.5 rule → the same faults in the same order, twice', async () => {
    const { control, status, events, connect, until } = await boot(1);

    await until(() => status().endpoints.length === 1, 'the endpoint');

    async function attempt(): Promise<boolean[]> {
      await control.startRun({ label: 'det', seed: 'same-seed' }, human);
      await control.setConfig(
        'py-echo',
        { faults: [{ id: 'half', probability: 0.5, corrupt: true }] },
        human,
      );
      const client = await connect(status().endpoints[0]?.url ?? '');
      const corrupted: boolean[] = [];
      for (let i = 0; i < 20; i += 1) {
        const before = client.bytes().byteLength;
        client.send(new Uint8Array([i]));
        const got = (await client.receive(before + 1))[before];
        corrupted.push(got === (i ^ 0xff));
      }
      client.close();
      await control.endRun(human);
      return corrupted;
    }

    const first = await attempt();
    const injectedFirst = events('testbed.fault.injected').length;
    const second = await attempt();
    expect(second).toEqual(first);
    expect(first.includes(true) && first.includes(false)).toBe(true);
    await until(
      () => events('testbed.fault.injected').length === injectedFirst * 2,
      'fault events',
    );
    expect(injectedFirst).toBe(first.filter(Boolean).length);
  }, 30_000);
});

test('TESTBED_EXAMPLE_CORES empty → no py-echo in the manifest', async () => {
  const testbed = await startTestServer({ env: { TESTBED_EXAMPLE_CORES: '' } });
  cleanups.push(testbed.stop);
  const manifest = testbed.plane.control.getManifest(human);
  expect(manifest.cores.map((core) => core.id)).not.toContain('py-echo');
});
