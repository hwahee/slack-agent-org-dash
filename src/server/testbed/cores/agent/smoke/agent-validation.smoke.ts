import { defineSmoke } from '@server/testbed/smoke';

export default defineSmoke({
  name: 'agent-validation',
  title: '기간이 7일을 넘는 훑기와 결함 규칙은 거절됨',
  spec: 'docs/spec.md §11 M2 4–5',
  requires: { cores: ['agent'] },
  async run(t) {
    await t.callError('agent_scan_history', { hours: 200 }, 'VALIDATION_ERROR');
    await t.callError(
      'agent_scan_history',
      { since: '2026-01-01T00:00:00.000Z', until: '2026-01-09T00:00:00.000Z' },
      'VALIDATION_ERROR',
    );
    await t.callError(
      'set_config',
      { core: 'agent', patch: { faults: [{ id: 'x', delayMs: 10 }] } },
      'VALIDATION_ERROR',
    );
  },
});
