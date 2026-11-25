/**
 * An external core on the dashboard (docs/spec.md §11 M14): the Python example
 * core with two replicas, on its own instance (`TESTBED_UI_PY_URL`, started
 * by `bun run test:ui` when python3 3.11+ is there).
 */
import { connect, type Socket } from 'node:net';

import { expect, test } from '@playwright/test';

import { TESTID } from '../src/client/testing/testids';

const PY_URL = process.env.TESTBED_UI_PY_URL;
const MISSING = process.env.TESTBED_UI_PYTHON_MISSING ?? 'TESTBED_UI_PY_URL is not set';
const REQUIRED = process.env.TESTBED_REQUIRE_PYTHON === '1';

interface Replica {
  id: string;
  state: string;
  pid?: number;
  endpoints: { url: string }[];
}

async function replicas(): Promise<Replica[]> {
  const response = await fetch(`${PY_URL ?? ''}/testbed/api/status`);
  const status = (await response.json()) as { cores: { id: string; replicas?: Replica[] }[] };
  return status.cores.find((core) => core.id === 'py-echo')?.replicas ?? [];
}

const sockets: Socket[] = [];
test.afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

/** A product-side connection to one replica; `data()` is what it received so far. */
async function connectTo(replica: string): Promise<{ data: () => string }> {
  const url = (await replicas()).find((entry) => entry.id === replica)?.endpoints[0]?.url ?? '';
  const { hostname, port } = new URL(url.replace(/^tcp:/, 'http:'));
  const socket = connect(Number(port), hostname === 'localhost' ? '127.0.0.1' : hostname);
  sockets.push(socket);
  let data = '';
  socket.on('data', (chunk) => (data += chunk.toString('utf8')));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return { data: () => data };
}

test('9. external core: two replicas, r1 killed and back with one restart, its log, broadcast to r0 only', async ({
  page,
}) => {
  if (PY_URL === undefined) {
    if (REQUIRED) throw new Error(`TESTBED_REQUIRE_PYTHON=1: ${MISSING}`);
    test.skip(true, MISSING);
    return;
  }
  test.setTimeout(60_000);
  await page.goto(PY_URL);
  const card = page.getByTestId(TESTID.testbed.coreCard('py-echo'));
  await expect(card).toContainText('external process');
  await expect(page.getByRole('img', { name: 'py-echo: running (2 replicas)' })).toBeVisible();
  const table = page.getByTestId(TESTID.testbed.coreCardReplicas('py-echo'));
  const r0 = page.getByTestId(TESTID.testbed.coreCardReplica('py-echo', 'r0'));
  const r1 = page.getByTestId(TESTID.testbed.coreCardReplica('py-echo', 'r1'));
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(r0).toHaveAttribute('data-state', 'running');
  await expect(r1).toHaveAttribute('data-state', 'running');

  const pid = (await replicas()).find((replica) => replica.id === 'r1')?.pid;
  expect(pid).toBeDefined();
  process.kill(pid ?? 0, 'SIGKILL');
  await expect(r1).not.toHaveAttribute('data-state', 'running');
  await expect(r1).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
  await expect(r1).toHaveAttribute('data-restarts', '1');
  expect((await replicas()).find((replica) => replica.id === 'r1')?.pid).not.toBe(pid);

  await r1.getByRole('button', { name: 'Show the r1 log' }).click();
  const log = page.getByTestId(TESTID.testbed.coreCardReplicaLog('py-echo', 'r1'));
  await expect(log).toContainText('testbed_core: py-echo r1 initialized');

  const toR0 = await connectTo('r0');
  const toR1 = await connectTo('r1');
  await expect(card).toContainText(/connectionsOpen\s*2/);
  await card.getByRole('button', { name: 'Broadcast' }).click();
  await page.getByTestId(TESTID.testbed.action.target('py-echo', 'broadcast')).selectOption('r0');
  await page.getByTestId(TESTID.testbed.action.field('py-echo', 'broadcast', 'text')).fill('hi');
  await page.getByTestId(TESTID.testbed.action.run('py-echo', 'broadcast')).click();
  const result = page.getByTestId(TESTID.testbed.action.result('py-echo', 'broadcast'));
  await expect(result.locator('[data-replica]')).toHaveCount(1);
  await expect(result.locator('[data-replica="r0"]')).toContainText('"sent": 1');
  await expect.poll(() => toR0.data()).toBe('hi');
  expect(toR1.data()).toBe('');
});
