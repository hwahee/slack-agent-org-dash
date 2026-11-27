import { defineSmoke } from '@server/testbed/smoke';

export default defineSmoke({
  name: 'agent-info',
  title: '관찰 코어 agent가 돌고, 데이터면 주소 없이 액션 두 개를 알림',
  spec: 'docs/spec.md §11 M2 1',
  requires: { cores: ['agent'] },
  async run(t) {
    const info = await t.call<{
      cores: { id: string; kind: string; state: string; endpoints: unknown[]; actions: string[] }[];
    }>('testbed_info');
    const agent = info.cores.find((core) => core.id === 'agent');
    t.ok(agent, 'the agent core is listed');
    t.equal(agent?.kind, 'passive');
    t.equal(agent?.state, 'running');
    t.equal(agent?.endpoints, [], 'no data-plane address');
    t.equal([...(agent?.actions ?? [])].sort(), ['scan_history', 'snapshot']);
  },
});
