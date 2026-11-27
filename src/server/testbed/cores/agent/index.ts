/**
 * Agent core: watches a Slack agent's diagnostics (docs/spec.md §3–§7). It
 * follows the agent's record files and status snapshot, moves every record
 * over as an `agent.*` event and judges whether the agent's ears (its Socket
 * Mode connection) are alive. It only reads: no data plane, no faults, nothing
 * sent anywhere, nothing written to the agent's folder.
 */
import type {
  AgentEventPayloads,
  AgentHealth,
  AgentHealthState,
  AgentRecordPayloadExtras,
} from '@shared/testbed/cores/agent/events';
import type { EventLevel } from '@shared/testbed/events';
import { s, toValidator } from '@shared/validation';
import { DIAG_VERSION } from 'slack-agent-org/src/diag/events';

import type { CoreContext, CoreDefinition, CoreInstance } from '../../core';
import { agentConfigValidator, agentDefaultConfig, type AgentConfig } from './config';
import { describeRecord } from './describe';
import { judgeHealth } from './health';
import { scanHistory, scanInput, scanOutput, type ScanOutput } from './scan';
import { DiagSource } from './source';
import { Tailer, type TailItem } from './tailer';

/** A poll this much later than `pollMs` means this process was frozen too (§5.3). */
const OWN_GAP_MS = 5_000;

const HEALTH_LEVEL: Record<AgentHealthState, EventLevel> = {
  ok: 'info',
  disconnected: 'warn',
  absent: 'warn',
  deaf: 'error',
  stopped: 'error',
};

export class AgentCore implements CoreInstance {
  private source: DiagSource | undefined;
  private tailer: Tailer | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastTick: number | undefined;
  private health: AgentHealth | null = null;
  private startedDataDir: string | undefined;
  private unreadableShown = false;
  private counters = { recordsRead: 0, invalidRecords: 0, rescuedMessages: 0, socketCloses: 0 };

  constructor(private readonly ctx: CoreContext<AgentConfig>) {}

  private emit<K extends keyof AgentEventPayloads>(
    kind: K,
    payload: AgentEventPayloads[K],
    fields: { summary: string; level: EventLevel },
  ): void {
    this.ctx.emit({ kind, payload, ...fields });
  }

  private backfillFrom(now: number): number | null {
    const minutes = this.ctx.config().backfillMinutes;
    return minutes > 0 ? now - minutes * 60_000 : null;
  }

  async start(): Promise<void> {
    const { dataDir } = this.ctx.config();
    this.startedDataDir = dataDir;
    this.source = new DiagSource(dataDir);
    this.tailer = new Tailer(this.source, { backfillFrom: this.backfillFrom(Date.now()) });
    this.running = true;
    this.lastTick = undefined;
    await this.tick();
    this.schedule();
  }

  stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return Promise.resolve();
  }

  reset(): Promise<void> {
    this.tailer?.reset(this.backfillFrom(Date.now()));
    this.counters = { recordsRead: 0, invalidRecords: 0, rescuedMessages: 0, socketCloses: 0 };
    this.health = null;
    this.unreadableShown = false;
    this.lastTick = undefined;
    return Promise.resolve();
  }

  /** A new data folder needs a new start; the rest is read live from the config. */
  applyConfig(next: AgentConfig): Promise<'applied' | 'restart-required'> {
    return Promise.resolve(
      this.startedDataDir !== undefined && next.dataDir !== this.startedDataDir
        ? 'restart-required'
        : 'applied',
    );
  }

  status() {
    const health = this.health;
    const sec = (ms: number | null | undefined) => (ms == null ? -1 : Math.round(ms / 1000));
    return {
      endpoints: [],
      counters: {
        ...this.counters,
        pingAgeSec: sec(health?.pingAgeMs),
        snapshotAgeSec: sec(health?.snapshotAgeMs),
      },
    };
  }

  /** The latest judgment (null before the first poll). */
  currentHealth(): AgentHealth | null {
    return this.health;
  }

  /** `snapshot` (§9): a fresh look now, not the last poll's. */
  async snapshot(): Promise<SnapshotOutput> {
    const source = this.source ?? new DiagSource(this.ctx.config().dataDir);
    const { pingStaleSec, snapshotStaleSec } = this.ctx.config();
    const read = await source.status();
    const now = Date.now();
    const health = judgeHealth(read, now, { pingStaleSec, snapshotStaleSec });
    const listing = await source.list();
    return {
      health: health.state,
      reason: health.reason,
      judgedAt: new Date(now).toISOString(),
      snapshotAgeMs: health.snapshotAgeMs,
      pingAgeMs: health.pingAgeMs,
      frameAgeMs: health.frameAgeMs,
      files: listing.ok ? listing.files.map((file) => file.name) : [],
      status: read.ok ? read.value : null,
    };
  }

  /** `scan_history` (§9): the period's records summed up, read only. */
  scan(input: unknown): Promise<ScanOutput> {
    const source = this.source ?? new DiagSource(this.ctx.config().dataDir);
    return scanHistory(source, scanInput.parse(input), Date.now());
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.loop(), this.ctx.config().pollMs);
  }

  private async loop(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.ctx.log.warn('agent core: poll failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.schedule();
  }

  /** One poll: new records, then the health judgment. */
  async tick(): Promise<void> {
    const source = this.source;
    const tailer = this.tailer;
    if (!source || !tailer || !this.running) return;
    const now = Date.now();
    const { pollMs, pingStaleSec, snapshotStaleSec, dataDir } = this.ctx.config();
    const late = this.lastTick !== undefined && now - this.lastTick > pollMs + OWN_GAP_MS;
    this.lastTick = now;

    const listing = await source.list();
    if (!listing.ok) {
      if (listing.reason === 'unreadable' && !this.unreadableShown) {
        this.unreadableShown = true;
        this.emit(
          'agent.source.unreadable',
          { dataDir, error: listing.error },
          { level: 'warn', summary: `진단 폴더를 읽을 수 없음: ${listing.error}` },
        );
      }
    } else {
      this.unreadableShown = false;
      for (const item of await tailer.poll(listing.files)) this.handle(item);
    }

    if (late || !this.running) return; // judge on the next poll, after the agent wrote again
    const next = judgeHealth(await source.status(), Date.now(), { pingStaleSec, snapshotStaleSec });
    const previous = this.health;
    this.health = next;
    if (previous?.state === next.state) return;
    this.emit(
      'agent.health.changed',
      {
        from: previous?.state ?? null,
        to: next.state,
        reason: next.reason,
        snapshotAgeMs: next.snapshotAgeMs,
        pingAgeMs: next.pingAgeMs,
        conn: next.conn,
        boot: next.boot,
      },
      {
        level: HEALTH_LEVEL[next.state],
        summary: `수신 상태 ${previous?.state ?? '처음'} → ${next.state}: ${next.reason}`,
      },
    );
  }

  private handle(item: TailItem): void {
    switch (item.type) {
      case 'invalid':
        this.counters.invalidRecords += 1;
        this.emit(
          'agent.record.invalid',
          { file: item.file, line: item.line, problem: item.problem, preview: item.preview },
          {
            level: 'warn',
            summary: `읽을 수 없는 기록 ${item.file}:${item.line} — ${item.problem}`,
          },
        );
        return;
      case 'mismatch':
        this.emit(
          'agent.contract.mismatch',
          { file: item.file, found: item.found, expected: DIAG_VERSION },
          {
            level: 'error',
            summary: `진단 계약 버전이 다름: 파일 v${String(item.found)}, 이 테스트베드 v${DIAG_VERSION}`,
          },
        );
        return;
      case 'record': {
        const { record, file, replayed } = item;
        this.counters.recordsRead += 1;
        if (record.kind === 'socket.closed') this.counters.socketCloses += 1;
        if (
          record.kind === 'message.observed' &&
          record.path === 'catchup' &&
          (record.outcome === 'queued' || record.outcome === 'overheard')
        ) {
          this.counters.rescuedMessages += 1;
        }
        const view = describeRecord(record, replayed);
        const extras: AgentRecordPayloadExtras = { file, replayed };
        this.ctx.emit({
          kind: `agent.${record.kind}`,
          level: view.level,
          summary: view.summary,
          payload: { ...record, ...extras },
          ...(view.correlationId !== undefined && { correlationId: view.correlationId }),
          ...(view.latencyMs !== undefined && { latencyMs: view.latencyMs }),
        });
      }
    }
  }
}

const snapshotOutput = toValidator(
  s.object({
    health: s.enum(['absent', 'stopped', 'disconnected', 'deaf', 'ok']),
    reason: s.string(),
    judgedAt: s.string(),
    snapshotAgeMs: s.nullable(s.number()),
    pingAgeMs: s.nullable(s.number()),
    frameAgeMs: s.nullable(s.number()),
    files: s.array(s.string()),
    status: s.unknown(),
  }),
);
interface SnapshotOutput {
  health: AgentHealthState;
  reason: string;
  judgedAt: string;
  snapshotAgeMs: number | null;
  pingAgeMs: number | null;
  frameAgeMs: number | null;
  files: string[];
  status: unknown;
}

const noInput = toValidator(s.object({}));

export const agentCore: CoreDefinition<AgentConfig, AgentCore> = {
  id: 'agent',
  kind: 'passive',
  title: '에이전트 진단',
  configSchema: agentConfigValidator,
  defaultConfig: agentDefaultConfig,
  faults: [],
  actions: {
    snapshot: {
      title: '지금 상태',
      description:
        '에이전트의 status.json을 지금 읽어 수신 건강 상태(absent·stopped·disconnected·deaf·ok)와 이유, 스냅샷·마지막 ping·마지막 프레임의 나이(ms), 진단 파일 목록, status.json 원문을 돌려줌. deaf는 연결됐다고 믿는데 ping이 pingStaleSec(기본 30초)보다 오래 멈춘 반쯤 죽은 소켓. 파일을 읽기만 하고 이벤트를 내지 않음. 락 불필요.',
      input: noInput,
      output: snapshotOutput,
      mutating: false,
      summarize: (output) => {
        const o = output as SnapshotOutput;
        return `수신 상태 ${o.health}: ${o.reason}`;
      },
      run: (instance) => instance.snapshot(),
    },
    scan_history: {
      title: '지난 기록 훑기',
      description:
        '진단 기록을 기간으로 훑어 합계를 돌려줌: kind별 건수, 에이전트 부팅, 소켓 연결·닫힘(시각·code·유지 시간)·재연결 요청·재연결 실패, 소켓으로/따라잡기로 받은 메시지 수, 귀가 놓쳐 따라잡기로 들어온 메시지(rescued, 늦은 순 최대 50건, delayMs), 시계 공백(잠자기) 수·합·최대(ms), 턴 수·실패 수. 기간은 since·until(ISO) 또는 최근 hours(1–168, 기본 24). 7일을 넘으면 VALIDATION_ERROR. 파일을 읽기만 하고 이벤트를 내지 않음. 락 불필요.',
      input: scanInput,
      output: scanOutput,
      mutating: false,
      summarize: (output) => {
        const o = output as ScanOutput;
        return `${o.from} ~ ${o.to}: 기록 ${o.records}건, 놓친 메시지 ${o.messages.rescued.length}건, 소켓 닫힘 ${o.socket.closes.length}건, 시계 공백 ${o.clockGaps.count}회`;
      },
      run: (instance, input) => instance.scan(input),
    },
  },
  create: (ctx) => new AgentCore(ctx),
};
