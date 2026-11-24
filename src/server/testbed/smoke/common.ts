/**
 * The common check: the same on every testbed (docs/testbed/verification.md).
 * Calls each of the 15 common tools at least once, and checks the lease
 * across two sessions: `LEASE_HELD` for the other agent, 423 for a person,
 * free again after `release_control`.
 */
import { defineSmoke } from './index';

export const COMMON_TOOLS = [
  'testbed_info',
  'get_config',
  'set_config',
  'start',
  'stop',
  'reset',
  'start_run',
  'end_run',
  'query_events',
  'get_event',
  'wait_for',
  'check',
  'export_run',
  'acquire_control',
  'release_control',
] as const;

export const commonCheck = defineSmoke({
  name: 'common',
  title: '공통 도구 15개와 제어 락 배타성',
  spec: 'docs/spec.md §11 M6',
  async run(t) {
    const info = await t.call<{ cores: { id: string }[]; lease: unknown }>('testbed_info');
    t.ok(info.lease === null, 'no one holds the lease at the start');
    const core = info.cores[0]?.id;
    if (core !== undefined) {
      const config = await t.call('get_config', { core });
      t.ok(typeof config === 'object', 'get_config returns the config');
      const set = await t.call<{ result: string }>('set_config', { core, patch: {} });
      t.equal(set.result, 'applied', 'an empty patch applies');
    } else {
      // A testbed without cores still has to show these tools answer.
      await t.callError('get_config', { core: 'none' }, 'NOT_FOUND');
      await t.callError('set_config', { core: 'none', patch: {} }, 'NOT_FOUND');
    }

    // The first operation took the lease for this session.
    await t.call('acquire_control');
    const second = await t.newSession('smoke:common:other');
    const denied = await second.callError('stop', {}, 'LEASE_HELD');
    t.ok(denied.message.includes('남은 시간'), 'LEASE_HELD says how long the lease lasts');
    const human = await t.rest<{ error?: { code: string } }>('POST', '/cores/_all/reset');
    t.equal(human.status, 423, 'a person is LOCKED out while an agent holds the lease');
    t.equal(human.body.error?.code, 'LOCKED');
    await second.call('query_events', { limit: 1 });

    await t.call('stop', {});
    await t.call('start', {});
    const reset = await t.call<{ cores: { state: string }[] }>('reset', {});
    t.ok(
      reset.cores.every((entry) => entry.state === 'running'),
      'every core runs again after stop → start → reset',
    );

    const run = await t.call<{ runId: string }>('start_run', { label: 'smoke:common' });
    const page = await t.call<{ events: { id: string }[]; nextCursor: string | null }>(
      'query_events',
      { runId: 'current' },
    );
    const first = page.events[0];
    t.ok(first !== undefined, 'the Run has events');
    const event = await t.call<{ kind: string }>('get_event', { id: first?.id });
    t.equal(event.kind, 'testbed.run.started');
    // start_run's own testbed.control.invoked comes right after the Run opened.
    await t.waitFor({ kind: 'testbed.control.invoked', after: first?.id }, 1, 5000);
    await t.expectCheck({ kind: 'testbed.run.started' }, { count: '==1' });
    const ended = await t.call<{ runId: string; endReason: string }>('end_run');
    t.equal(ended.endReason, 'ended');
    const exported = await t.call<{ runId: string; url: string }>('export_run', {
      runId: run.runId,
    });
    t.ok(exported.url.endsWith(`/testbed/api/runs/${run.runId}/export`), 'export_run URL');

    t.equal(await t.call('release_control'), { released: true });
    await second.call('acquire_control');
    t.equal(await second.call('release_control'), { released: true });
    const status = await t.rest<{ lease: unknown }>('GET', '/status', { actor: 'ci' });
    t.equal(status.body.lease, null, 'the lease is free at the end');
  },
});
