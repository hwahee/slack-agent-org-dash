/**
 * Agent core against a real folder (docs/spec.md §11 M1): a temporary
 * `<dataDir>/diag/` is written the way the agent writes it, and the core
 * follows it. Records are synthetic, built to the pinned contract.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentHealthState } from '@shared/testbed/cores/agent/events';
import type { TestbedEvent } from '@shared/testbed/events';
import { validateRecord, validateSnapshot } from 'slack-agent-org/src/diag/events';

import { silentLogger } from '../../../lib/log';
import { CoreHost } from '../../core-host';
import { EventBus } from '../../events/bus';
import { createMemoryRunStore } from '../../runs/memory-store';
import { RunManager } from '../../runs/runs';
import { waitForEvent } from '../../testing';
import { agentCore, type AgentCore } from '.';
import { MAX_READ_BYTES } from './tailer';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// ── A fake agent folder ─────────────────────────────────────────────────────

const DAY = new Date().toISOString().slice(0, 10);

async function agentFolder() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-data-'));
  const diag = join(dataDir, 'diag');
  await mkdir(diag);
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  let seq = 0;
  const boot = 'b-test0001';
  const record = (kind: string, fields: Record<string, unknown>, t = new Date()) => {
    seq += 1;
    const line = { v: 1, t: t.toISOString(), mono: seq * 10, boot, seq, kind, ...fields };
    const checked = validateRecord(line);
    if (!checked.ok)
      throw new Error(`fixture record does not fit the contract: ${checked.problem}`);
    return line;
  };
  const file = (day = DAY) => join(diag, `diag-${day}.jsonl`);
  return {
    dataDir,
    diag,
    record,
    file,
    async append(line: object | string, day = DAY) {
      await appendFile(file(day), `${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
    },
    async appendRaw(text: string, day = DAY) {
      await appendFile(file(day), text);
    },
    async snapshot(socket: Record<string, unknown> | null, writtenAt = new Date()) {
      const value = {
        v: 1,
        writtenAt: writtenAt.toISOString(),
        mono: 1,
        boot,
        pid: 4242,
        sections: socket === null ? {} : { socket: { ...SOCKET, ...socket } },
        clock: { lastGapAt: null },
        diag: { records: seq, writeErrors: 0 },
      };
      const checked = validateSnapshot(value);
      if (!checked.ok) throw new Error(`fixture snapshot does not fit: ${checked.problem}`);
      await writeFile(join(diag, 'status.json'), JSON.stringify(value));
    },
  };
}

const SOCKET = {
  conn: 1,
  live: true,
  readyState: 1,
  bufferedAmount: 0,
  connectedAt: new Date(Date.now() - 60_000).toISOString(),
  lastFrameAt: new Date().toISOString(),
  lastFrameType: 'ping',
  framesReceived: 3,
  pingsReceived: 6,
  lastPingAt: new Date().toISOString(),
  lastEnvelopeAt: null,
  reconnects: 0,
};

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// ── The core under a host ───────────────────────────────────────────────────

async function boot(
  dataDir: string,
  env: Record<string, string> = {},
  config: Record<string, unknown> = {},
) {
  const bus = new EventBus({ instanceId: 'test' });
  const runs = new RunManager(bus, createMemoryRunStore(), { bootSeed: 'agent-test' });
  const host = new CoreHost({
    bus,
    runs,
    log: silentLogger,
    env: { AGENT_DATA_DIR: dataDir, AGENT_POLL_MS: '200', AGENT_BACKFILL_MINUTES: '0', ...env },
  });
  let instance: AgentCore | undefined;
  host.register({
    ...agentCore,
    create: (ctx) => (instance = agentCore.create(ctx as Parameters<typeof agentCore.create>[0])),
  });
  if (Object.keys(config).length > 0) await host.setConfig('agent', config);
  await host.start('agent');
  cleanups.push(() => host.stopAll());
  const events = (prefix = 'agent.') => bus.buffered().filter((e) => e.kind.startsWith(prefix));
  const waitKind = (kind: string, where: (event: TestbedEvent) => boolean = () => true) =>
    waitForEvent(bus, (event) => event.kind === kind && where(event), 3_000);
  const healthSteps = () =>
    events('agent.health.changed').map((e) => (e.payload as { to: AgentHealthState }).to);
  if (!instance) throw new Error('core not created');
  return { bus, host, core: instance, events, waitKind, healthSteps };
}

const payload = <T>(event: TestbedEvent | undefined) => event?.payload as T;

// ── Records → events ────────────────────────────────────────────────────────

describe('agent core — records become events', () => {
  test('every kind arrives as agent.<kind> with the level and summary of the spec', async () => {
    const agent = await agentFolder();
    await agent.snapshot({});
    const { events, waitKind } = await boot(agent.dataDir, {}, { eventLevel: 'debug' });

    const cases: [string, Record<string, unknown>, string, RegExp][] = [
      [
        'process.booted',
        { pid: 1, bunVersion: '1.4.2', config: CONFIG },
        'info',
        /^에이전트 시작 \(pid 1, bun 1\.4\.2\)$/,
      ],
      [
        'process.shutdown',
        { phase: 'forced', signal: 'SIGTERM' },
        'warn',
        /^에이전트 종료 forced \(SIGTERM\)$/,
      ],
      [
        'clock.gap',
        { expectedMs: 1000, wallElapsedMs: 61_000, monoElapsedMs: 1000 },
        'info',
        /^에이전트가 61\.0s 멈춤 \(잠자기 의심\)$/,
      ],
      [
        'desk.state',
        { ready: false, problem: 'screen recording' },
        'warn',
        /^데스크 막힘: screen recording$/,
      ],
      [
        'socket.url-requested',
        { conn: 2, ok: false, ms: 30, error: 'invalid_auth' },
        'warn',
        /^소켓 주소 요청 #2 실패: invalid_auth$/,
      ],
      ['socket.opened', { conn: 2, msSinceRequest: 500 }, 'debug', /^소켓 열림 #2$/],
      [
        'socket.hello',
        { conn: 2, numConnections: 2, helloAfterMs: 600 },
        'warn',
        /^소켓 연결 #2 \(연결 수 2\)$/,
      ],
      [
        'socket.disconnect-requested',
        { conn: 2, reason: 'warning' },
        'info',
        /^Slack이 재연결 요청 #2 \(warning\)$/,
      ],
      ['socket.error', { conn: 2, message: 'boom' }, 'warn', /^소켓 오류 #2: boom$/],
      [
        'socket.closed',
        {
          conn: 2,
          code: 1006,
          reason: 'Connection ended',
          wasClean: false,
          greeted: true,
          livedMs: 185_315,
          lastFrameAgoMs: 17_390,
        },
        'warn',
        /^소켓 닫힘 #2 code 1006, 185\.3s 유지, 마지막 프레임 17\.4s 전$/,
      ],
      [
        'socket.reconnect-scheduled',
        { delayMs: 1000, attempt: 1 },
        'info',
        /^재연결 예약 1000ms 뒤 \(시도 1\)$/,
      ],
      [
        'socket.reconnect-failed',
        { error: 'ENOTFOUND', nextDelayMs: 2000 },
        'warn',
        /^재연결 실패: ENOTFOUND$/,
      ],
      [
        'socket.envelope',
        {
          conn: 2,
          type: 'events_api',
          envelopeId: 'e1',
          retryAttempt: 1,
          retryReason: 'timeout',
          channel: 'D1',
          ts: '1.0',
        },
        'warn',
        /^envelope events_api 재전송 1회째 \(timeout\)$/,
      ],
      [
        'socket.frame-unreadable',
        { conn: 2, bytes: 12 },
        'warn',
        /^읽을 수 없는 프레임 #2 \(12B\)$/,
      ],
      [
        'message.observed',
        {
          id: 'D1:1.0',
          path: 'catchup',
          channel: 'D1',
          ts: '1.0',
          receivedAt: ago(0),
          delayMs: 282_000,
          deliver: true,
          outcome: 'queued',
        },
        'warn',
        /^메시지 따라잡기로 받음 D1:1\.0, 282\.0s 늦음 → queued$/,
      ],
      [
        'inbox.taken',
        { by: 'turn-start', messages: [{ id: 'D1:1.0', waitedMs: 900 }] },
        'info',
        /^대기열에서 1건 꺼냄 \(turn-start\)$/,
      ],
      [
        'turn.started',
        { conversation: 'D1', cause: 'messages', messageIds: ['D1:1.0'] },
        'info',
        /^턴 시작 D1 \(messages, 메시지 1건\)$/,
      ],
      [
        'turn.ended',
        { conversation: 'D1', ms: 16_000, ok: false, error: 'x' },
        'warn',
        /^턴 끝 D1 16\.0s 실패$/,
      ],
      [
        'triage.decided',
        { conversation: 'C1', judged: ['C1:2.0'], outcome: 'unreadable', ids: [], ms: 900 },
        'warn',
        /^채널 판단 C1: unreadable$/,
      ],
      [
        'poll.ran',
        { skipped: false, ms: 5734, tasks: [{ name: 'catchup', ms: 5000, ok: false }] },
        'warn',
        /^폴링 5734ms$/,
      ],
      [
        'catchup.ran',
        {
          trigger: 'poll',
          ms: 2500,
          firstRun: false,
          since: ago(600_000),
          reads: 11,
          found: 2,
          answered: 2,
          rememberedOnly: 0,
        },
        'info',
        /^따라잡기 \(poll\) 2건 찾음$/,
      ],
      [
        'heartbeat.beat',
        { outcome: 'left', problem: 'slack connection down' },
        'warn',
        /^하트비트 left: slack connection down$/,
      ],
    ];
    for (const [kind, fields] of cases) await agent.append(agent.record(kind, fields));
    await waitKind('agent.heartbeat.beat');

    for (const [kind, , level, summary] of cases) {
      const event = events(`agent.${kind}`).find((e) => e.kind === `agent.${kind}`);
      expect(event, kind).toBeDefined();
      expect(event?.level, kind).toBe(level as TestbedEvent['level']);
      expect(event?.summary, kind).toMatch(summary);
      expect(event?.actor, kind).toBe('product');
      expect(payload<{ kind: string; replayed: boolean; file: string }>(event)).toMatchObject({
        kind,
        replayed: false,
        file: `diag-${DAY}.jsonl`,
      });
    }
  });

  test('correlation and latency: a message, its envelope, the inbox and the turn', async () => {
    const agent = await agentFolder();
    await agent.snapshot({});
    const { events, waitKind } = await boot(agent.dataDir, {}, { eventLevel: 'debug' });
    await agent.append(
      agent.record('socket.envelope', {
        conn: 1,
        type: 'events_api',
        envelopeId: 'e',
        retryAttempt: 0,
        channel: 'D1',
        ts: '5.0',
      }),
    );
    await agent.append(
      agent.record('message.observed', {
        id: 'D1:5.0',
        path: 'socket',
        channel: 'D1',
        ts: '5.0',
        receivedAt: ago(0),
        delayMs: 420,
        deliver: true,
        outcome: 'queued',
      }),
    );
    await agent.append(
      agent.record('inbox.taken', {
        by: 'turn-start',
        messages: [{ id: 'D1:5.0', waitedMs: 1200 }],
      }),
    );
    await agent.append(agent.record('turn.ended', { conversation: 'D1', ms: 16_000, ok: true }));
    await waitKind('agent.turn.ended');

    const envelope = events('agent.socket.envelope')[0];
    const message = events('agent.message.observed')[0];
    expect(envelope?.level).toBe('debug');
    expect(envelope?.correlationId).toBe('D1:5.0');
    expect(message).toMatchObject({ level: 'info', correlationId: 'D1:5.0', latencyMs: 420 });
    expect(message?.summary).toBe('메시지 소켓으로 받음 D1:5.0, 0.4s 늦음 → queued');
    expect(events('agent.inbox.taken')[0]).toMatchObject({
      correlationId: 'D1:5.0',
      latencyMs: 1200,
    });
    expect(events('agent.turn.ended')[0]).toMatchObject({ latencyMs: 16_000 });
  });

  test("eventLevel info (the default) keeps the agent's debug records out of the buffer", async () => {
    const agent = await agentFolder();
    await agent.snapshot({});
    const { events, waitKind } = await boot(agent.dataDir);
    await agent.append(agent.record('heartbeat.beat', { outcome: 'working' }));
    await agent.append(agent.record('heartbeat.beat', { outcome: 'failed', problem: 'ENOTFOUND' }));
    await waitKind('agent.heartbeat.beat');
    expect(events('agent.heartbeat.beat').map((e) => e.level)).toEqual(['warn']);
  });
});

const CONFIG = {
  pollMinutes: 10,
  catchup: 'on',
  catchupMaxHours: 24,
  slackStatus: 'on',
  channelTriage: 'on',
  diagSnapshotSec: 5,
  diagRetentionDays: 7,
};

// ── Following files ─────────────────────────────────────────────────────────

describe('agent core — following the files', () => {
  test('a line without its newline waits for it', async () => {
    const agent = await agentFolder();
    await agent.snapshot({});
    const { events, waitKind } = await boot(agent.dataDir);
    const line = JSON.stringify(
      agent.record('clock.gap', { expectedMs: 1000, wallElapsedMs: 9000, monoElapsedMs: 1000 }),
    );
    await agent.appendRaw(line.slice(0, 20));
    await Bun.sleep(500);
    expect(events('agent.clock.gap')).toHaveLength(0);
    await agent.appendRaw(`${line.slice(20)}\n`);
    await waitKind('agent.clock.gap');
    expect(events('agent.record.invalid')).toHaveLength(0);
  });

  test('a new day file, a file that got shorter, a file that went away', async () => {
    const agent = await agentFolder();
    await agent.snapshot({});
    const { events, waitKind } = await boot(agent.dataDir);
    const gap = (ms: number) =>
      agent.record('clock.gap', { expectedMs: 1000, wallElapsedMs: ms, monoElapsedMs: ms });

    await agent.append(gap(6000), '2026-01-01');
    await waitKind(
      'agent.clock.gap',
      (e) => payload<{ file: string }>(e).file === 'diag-2026-01-01.jsonl',
    );

    // Rewritten shorter, with records of a new agent boot: read again from the top.
    const reborn = { ...gap(7), boot: 'b-reborn01', seq: 1 };
    await writeFile(agent.file('2026-01-01'), `${JSON.stringify(reborn)}\n`);
    await waitKind('agent.clock.gap', (e) => payload<{ boot: string }>(e).boot === 'b-reborn01');

    await rm(agent.file('2026-01-01'));
    await agent.append(gap(8000));
    await waitKind(
      'agent.clock.gap',
      (e) => payload<{ wallElapsedMs: number }>(e).wallElapsedMs === 8000,
    );
    expect(events('agent.clock.gap')).toHaveLength(3);
  });

  test('a re-read line of the same boot is not moved over twice', async () => {
    const agent = await agentFolder();
    await agent.snapshot({});
    const { events, waitKind } = await boot(agent.dataDir);
    const first = agent.record('clock.gap', {
      expectedMs: 1000,
      wallElapsedMs: 6000,
      monoElapsedMs: 1000,
    });
    await agent.append(first);
    await waitKind('agent.clock.gap');
    await writeFile(agent.file(), ''); // shorter: read again from the top
    await agent.append(first);
    await agent.append(
      agent.record('clock.gap', { expectedMs: 1000, wallElapsedMs: 7000, monoElapsedMs: 1000 }),
    );
    await waitKind(
      'agent.clock.gap',
      (e) => payload<{ wallElapsedMs: number }>(e).wallElapsedMs === 7000,
    );
    expect(events('agent.clock.gap')).toHaveLength(2);
  });

  test('bad lines: not JSON, outside the contract, too long, another contract version', async () => {
    const agent = await agentFolder();
    await agent.snapshot({});
    const { events, waitKind } = await boot(agent.dataDir);

    await agent.append('not json');
    await agent.append({
      v: 1,
      t: ago(0),
      mono: 1,
      boot: 'b',
      seq: 1,
      kind: 'heartbeat.beat',
      outcome: 'working',
      text: 'secret',
    });
    await agent.append({ v: 2, t: ago(0), kind: 'whatever' });
    await agent.append({ v: 2, t: ago(0), kind: 'again' });
    await agent.appendRaw(`${'x'.repeat(MAX_READ_BYTES + 10)}\n`);
    await agent.append(
      agent.record('clock.gap', { expectedMs: 1000, wallElapsedMs: 6000, monoElapsedMs: 1000 }),
    );
    await waitKind('agent.clock.gap');

    const invalid = events('agent.record.invalid').map((e) =>
      payload<{ line: number; problem: string }>(e),
    );
    expect(invalid.map((i) => i.line)).toEqual([1, 2, 5]);
    expect(invalid[0]?.problem).toBe('not JSON');
    expect(invalid[1]?.problem).toContain('heartbeat.beat');
    expect(invalid[2]?.problem).toBe('line too long');
    const mismatch = events('agent.contract.mismatch');
    expect(mismatch).toHaveLength(1); // once per file
    expect(mismatch[0]).toMatchObject({ level: 'error' });
    expect(mismatch[0]?.summary).toBe('진단 계약 버전이 다름: 파일 v2, 이 테스트베드 v1');
  });

  test('backfill: only records inside the window come back, marked as past records', async () => {
    const agent = await agentFolder();
    await agent.snapshot({});
    const gap = (ms: number, t: Date) =>
      agent.record('clock.gap', { expectedMs: 1000, wallElapsedMs: ms, monoElapsedMs: ms }, t);
    await agent.append(gap(6000, new Date(Date.now() - 3 * 60 * 60_000))); // 3h ago
    await agent.append(gap(7000, new Date(Date.now() - 30 * 60_000))); // 30 min ago

    const withBackfill = await boot(agent.dataDir, { AGENT_BACKFILL_MINUTES: '60' });
    const replayed = withBackfill.events('agent.clock.gap');
    const seen = replayed.map((e) => payload<{ wallElapsedMs: number; replayed: boolean }>(e));
    expect(seen.map((p) => [p.wallElapsedMs, p.replayed])).toEqual([[7000, true]]);
    expect(replayed[0]?.summary).toStartWith('[지난 기록] ');
    await withBackfill.host.stopAll();

    const without = await boot(agent.dataDir, { AGENT_BACKFILL_MINUTES: '0' });
    await Bun.sleep(300);
    expect(without.events('agent.clock.gap')).toHaveLength(0);
  });

  test('no folder yet: absent, then followed once it appears; an unreadable folder says so once', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-empty-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const { events, waitKind, healthSteps } = await boot(dataDir);
    expect(healthSteps()).toEqual(['absent']);
    expect(events('agent.source.unreadable')).toHaveLength(0);

    await writeFile(join(dataDir, 'diag'), 'a file where the folder should be');
    await waitKind('agent.source.unreadable');
    await Bun.sleep(500);
    expect(events('agent.source.unreadable')).toHaveLength(1);
  });
});

// ── Health ──────────────────────────────────────────────────────────────────

describe('agent core — receive health', () => {
  test('absent → ok → deaf → disconnected → ok → stopped, each exactly once', async () => {
    const agent = await agentFolder();
    const { healthSteps, core } = await boot(agent.dataDir);
    expect(healthSteps()).toEqual(['absent']);

    // Wait for the next change, not any earlier one with the same state.
    const step = async (to: AgentHealthState, write: () => Promise<void>) => {
      const before = healthSteps().length;
      await write();
      for (let i = 0; i < 60 && healthSteps().length === before; i++) await Bun.sleep(50);
      expect(healthSteps().at(-1)).toBe(to);
    };
    await step('ok', () => agent.snapshot({ lastPingAt: ago(2_000) }));
    await step('deaf', () => agent.snapshot({ lastPingAt: ago(31_000) }));
    await step('disconnected', () => agent.snapshot({ live: false, lastPingAt: ago(31_000) }));
    await step('ok', () => agent.snapshot({ lastPingAt: ago(1_000) }));
    await step('stopped', () =>
      agent.snapshot({ lastPingAt: ago(1_000) }, new Date(Date.now() - 25_000)),
    );
    await Bun.sleep(500);

    expect(healthSteps()).toEqual(['absent', 'ok', 'deaf', 'disconnected', 'ok', 'stopped']);
    expect(core.currentHealth()?.reason).toMatch(/^스냅샷 2\d\.\ds 전$/);
  });

  test('the deaf event says how long the pings have stopped', async () => {
    const agent = await agentFolder();
    await agent.snapshot({ lastPingAt: ago(31_200) });
    const { events } = await boot(agent.dataDir);
    const [deaf] = events('agent.health.changed');
    expect(deaf).toMatchObject({ level: 'error' });
    expect(deaf?.summary).toMatch(/^수신 상태 처음 → deaf: 마지막 ping 31\.\ds 전$/);
    expect(payload<{ from: unknown; conn: number; boot: string }>(deaf)).toMatchObject({
      from: null,
      conn: 1,
      boot: 'b-test0001',
    });
  });

  test('a poll that came late (this machine slept too) is not judged', async () => {
    const agent = await agentFolder();
    await agent.snapshot({ lastPingAt: ago(1_000) });
    const { core, healthSteps } = await boot(agent.dataDir);
    expect(healthSteps()).toEqual(['ok']);
    await core.stop(); // drive the polls by hand from here

    await agent.snapshot({ lastPingAt: ago(1_000) }, new Date(Date.now() - 60_000));
    const late = core as unknown as { lastTick: number; running: boolean; tick(): Promise<void> };
    late.running = true;
    late.lastTick = Date.now() - 60_000; // the previous poll was a minute ago
    await late.tick();
    expect(healthSteps()).toEqual(['ok']); // not judged
    await late.tick();
    expect(healthSteps()).toEqual(['ok', 'stopped']); // the next, on time, is
    late.running = false;
  });
});

// ── Read only ───────────────────────────────────────────────────────────────

async function fingerprint(folder: string) {
  const out: Record<string, string> = {};
  for (const name of (await readdir(folder)).sort()) {
    const path = join(folder, name);
    const info = await stat(path);
    const hash = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    out[name] = `${info.size}:${info.mtimeMs}:${hash}`;
  }
  return out;
}

describe('agent core — read only', () => {
  test("starting, resetting and stopping leaves the agent's folder exactly as it was", async () => {
    const agent = await agentFolder();
    await agent.snapshot({ lastPingAt: ago(1_000) });
    for (let i = 0; i < 20; i++) {
      await agent.append(
        agent.record('clock.gap', {
          expectedMs: 1000,
          wallElapsedMs: 6000 + i,
          monoElapsedMs: 1000,
        }),
      );
    }
    await agent.append('not json');
    const before = await fingerprint(agent.diag);
    const beforeRoot = await readdir(agent.dataDir);

    const { host } = await boot(agent.dataDir, { AGENT_BACKFILL_MINUTES: '60' });
    await Bun.sleep(500);
    await host.reset('agent');
    await Bun.sleep(500);
    await host.stop('agent');

    expect(await fingerprint(agent.diag)).toEqual(before);
    expect(await readdir(agent.dataDir)).toEqual(beforeRoot);
  });
});
