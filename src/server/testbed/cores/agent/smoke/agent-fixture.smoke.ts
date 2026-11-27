import { defineSmoke } from '@server/testbed/smoke';

/** The synthetic agent folder shipped with the repository (fixtures/agent-data). */
const FIXTURE = 'fixtures/agent-data';
const FROM = '2026-01-02T00:00:00.000Z';
const TO = '2026-01-02T01:00:00.000Z';

export default defineSmoke({
  name: 'agent-fixture',
  title: '고정 데이터로: 지금 상태는 stopped, 지난 기록에 놓친 DM 1건·소켓 닫힘 1건·시계 공백',
  spec: 'docs/spec.md §11 M2 2–3',
  requires: { cores: ['agent'] },
  async run(t) {
    const { dataDir } = await t.call<{ dataDir: string }>('get_config', { core: 'agent' });
    const point = async (dir: string) => {
      const out = await t.call<{ result: string }>('set_config', {
        core: 'agent',
        patch: { dataDir: dir },
      });
      if (out.result === 'restart-required') {
        await t.call('stop', { core: 'agent' });
        await t.call('start', { core: 'agent' });
      }
      return out.result;
    };

    try {
      t.equal(await point(FIXTURE), dataDir === FIXTURE ? 'applied' : 'restart-required');

      const now = await t.call<{
        health: string;
        files: string[];
        status: { boot?: string } | null;
      }>('agent_snapshot');
      t.equal(now.health, 'stopped', 'the fixture snapshot is old');
      t.equal(now.files, ['diag-2026-01-02.jsonl']);
      t.equal(now.status?.boot, 'b-fixture1');

      const past = await t.call<{
        records: number;
        invalid: number;
        socket: { closes: { code: number }[]; connections: number };
        messages: { socket: number; catchup: number; rescued: { id: string; delayMs: number }[] };
        clockGaps: { count: number; maxMs: number };
        turns: { count: number; failed: number };
      }>('agent_scan_history', { since: FROM, until: TO });
      t.equal(past.invalid, 0);
      t.equal(past.records, 26);
      t.equal(past.socket.connections, 2);
      t.equal(
        past.socket.closes.map((close) => close.code),
        [1006],
      );
      t.equal(past.messages.rescued.length, 1, 'one DM came in only through the catch-up');
      t.ok((past.messages.rescued[0]?.delayMs ?? 0) >= 60_000, 'it was at least a minute late');
      t.equal(past.messages.socket, 1);
      t.equal(past.messages.catchup, 2);
      t.ok(past.clockGaps.count >= 1 && past.clockGaps.maxMs >= 60_000, 'a sleep was seen');
      t.equal(past.turns, { count: 2, failed: 0 });
    } finally {
      await point(dataDir);
    }
  },
});
