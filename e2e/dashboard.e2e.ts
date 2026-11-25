/**
 * The dashboard, driven like a person while REST and TCP play the agent and
 * the product (docs/spec.md §11 M10). ARIA first, then `TESTID`.
 */
import { expect, test, type Page } from '@playwright/test';

import { TESTID } from '../src/client/testing/testids';
import { api, echoPort, gateLiveUpdates, resetTestbed, takeLease, tcp } from './helpers';

test.beforeEach(async () => {
  await resetTestbed();
});

async function openDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('img', { name: 'sample: running' })).toBeVisible();
}

/** The config editor with the server value loaded. */
async function configEditor(page: Page) {
  const editor = page.getByLabel('Config (JSON)');
  await expect(editor).toHaveValue(/"maxConnections"/);
  return editor;
}

test('1. basic view: the status bar shows sample running, the connection panel its TCP address', async ({
  page,
}) => {
  await openDashboard(page);
  await expect(page.getByTestId(TESTID.testbed.statusBar.core('sample'))).toHaveAttribute(
    'data-state',
    'running',
  );
  await expect(page.getByTestId(TESTID.testbed.connection.endpoint('sample', 'echo'))).toHaveText(
    `tcp://127.0.0.1:${await echoPort()}`,
  );
});

test('2. event flow: TCP data shows up in the log, and its payload in the detail panel', async ({
  page,
}) => {
  await openDashboard(page);
  const client = await tcp();
  client.send('hello');
  await client.received('hello');

  const row = page.getByRole('listitem').filter({ hasText: 'sample.data.echoed' }).last();
  await row.click();
  const payload = page.getByTestId(TESTID.testbed.detail.payload);
  const bytes = payload.locator('.tb-json__line[data-path="payload.bytes"]');
  await expect(bytes).toContainText('5');
  await expect(payload).toContainText('"hello"');

  // Typing fast into a filter keeps every character (the address follows).
  const kind = page.getByLabel('Kind prefix');
  await kind.pressSequentially('sample.data');
  await expect(kind).toHaveValue('sample.data');
  const search = page.getByLabel('Search summary');
  await search.pressSequentially('C-1 echoed');
  await expect(search).toHaveValue('C-1 echoed');
  await expect(page).toHaveURL(/kind=sample\.data/);
  await expect(page).toHaveURL(/q=C-1\+echoed/);
});

test('3. Run: start from the Run tab, data, end; the past Run summarizes it', async ({ page }) => {
  await openDashboard(page);
  await page.getByRole('tab', { name: 'Runs' }).click();
  await page.getByLabel('label', { exact: true }).fill('ui-run');
  await page.getByRole('button', { name: 'Start Run' }).click();
  await expect(page.getByTestId(TESTID.testbed.statusBar.run)).toContainText('Run ui-run');

  const client = await tcp();
  client.send('hello');
  await client.received('hello');
  await page.getByRole('button', { name: 'End Run' }).click();

  await expect(page.getByTestId(TESTID.testbed.statusBar.run)).toHaveText('No open Run');
  await page.getByRole('button', { name: /^ui-run run-/ }).click();
  const summary = page.getByTestId(TESTID.testbed.runs.summary);
  await expect(summary.getByRole('row', { name: 'sample.data.echoed 1' })).toBeVisible();
});

test('4. lease: editing input survives a lease, every operation is aria-disabled; after release the changed server value offers "keep mine"', async ({
  page,
}) => {
  await openDashboard(page);
  await page.getByRole('button', { name: 'Broadcast' }).click();
  const editor = await configEditor(page);
  const mine = JSON.stringify(
    { ...JSON.parse(await editor.inputValue()), maxConnections: 42 },
    null,
    2,
  );
  await editor.fill(mine);

  const lease = await takeLease();
  await expect(page.locator('html')).toHaveAttribute('data-lease', 'agent');
  await expect(page.getByTestId(TESTID.testbed.leaseBanner)).toContainText('agent is in control');
  const config = page.getByRole('region', { name: 'Config' });
  await expect(config.getByTestId(TESTID.testbed.editor.lockedNotice)).toBeVisible();
  for (const control of [
    page.getByRole('button', { name: 'Start', exact: true }),
    page.getByRole('button', { name: 'Stop', exact: true }),
    page.getByRole('button', { name: 'Reset', exact: true }),
    page.getByRole('button', { name: 'Save config' }),
    page.getByRole('button', { name: 'Save rules' }),
    page.getByRole('button', { name: 'Run', exact: true }),
  ]) {
    await expect(control).toHaveAttribute('aria-disabled', 'true');
  }
  await expect(editor).toHaveValue(mine);
  await expect(editor).toHaveJSProperty('readOnly', true);

  // The holder changes the same setting, then lets go.
  await api('PATCH', '/cores/sample/config', {
    actor: 'agent',
    lease: lease.leaseId,
    body: { maxConnections: 9 },
  });
  await lease.release();
  await expect(page.locator('html')).toHaveAttribute('data-lease', 'none');
  const changed = config.getByTestId(TESTID.testbed.editor.serverChanged);
  await expect(changed).toBeVisible();
  await changed.getByRole('button', { name: 'Keep mine' }).click();
  await expect(editor).toHaveValue(mine);
  await expect(editor).toHaveJSProperty('readOnly', false);

  await page.getByRole('button', { name: 'Save config' }).click();
  await expect
    .poll(
      async () =>
        (await api<{ maxConnections: number }>('GET', '/cores/sample/config')).body.maxConnections,
    )
    .toBe(42);
});

test('5. a save the lease beat to the server: 423, the notice, the input kept', async ({
  page,
}) => {
  const gate = await gateLiveUpdates(page);
  await openDashboard(page);
  const editor = await configEditor(page);
  const mine = JSON.stringify(
    { ...JSON.parse(await editor.inputValue()), maxConnections: 43 },
    null,
    2,
  );
  await editor.fill(mine);

  // The lease is taken but the page has not heard yet when the save goes out.
  gate.hold();
  const lease = await takeLease();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/testbed/api/cores/sample/config') &&
      response.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Save config' }).click();
  expect((await saved).status()).toBe(423);

  const config = page.getByRole('region', { name: 'Config' });
  await expect(config.getByTestId(TESTID.testbed.editor.lockedNotice)).toBeVisible();
  await expect(editor).toHaveValue(mine);
  await expect(editor).toHaveJSProperty('readOnly', true);

  gate.flush();
  await lease.release();
});

test('6. action: broadcast "hi" reaches the TCP client and shows { sent: 1 }', async ({ page }) => {
  await openDashboard(page);
  const client = await tcp();
  await expect(page.getByTestId(TESTID.testbed.coreCard('sample'))).toContainText(
    /connectionsOpen\s*1/,
  );
  await page.getByRole('button', { name: 'Broadcast' }).click();
  await page.getByLabel('text', { exact: true }).fill('hi');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await client.received('hi');
  await expect(page.getByTestId(TESTID.testbed.action.result('sample', 'broadcast'))).toContainText(
    '"sent": 1',
  );
});

test('7. fault rules: a disconnect rule closes the connection, and the log shows testbed.fault.injected', async ({
  page,
}) => {
  await openDashboard(page);
  await page.getByRole('button', { name: 'Add rule' }).click();
  await page.getByLabel('effect').selectOption('disconnect');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

  const client = await tcp();
  client.send('hello');
  await client.closed();
  await expect(
    page.getByRole('listitem').filter({ hasText: 'testbed.fault.injected' }).last(),
  ).toBeVisible();
});

test('8. agent timeline: an agent taking and giving back the lease', async ({ page }) => {
  await openDashboard(page);
  const lease = await takeLease();
  await lease.release();
  await page.getByRole('tab', { name: 'Agent timeline' }).click();
  const timeline = page.getByTestId(TESTID.testbed.agentTimeline.root);
  const short = lease.leaseId.slice(0, 4);
  await expect(
    timeline.getByRole('button', {
      name: new RegExp(`agent · ${short} testbed\\.lease\\.acquired`),
    }),
  ).toBeVisible();
  await expect(
    timeline.getByRole('button', {
      name: new RegExp(`agent · ${short} testbed\\.lease\\.released`),
    }),
  ).toBeVisible();
});
