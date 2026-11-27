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
import { DIAG_VERSION } from 'slack-agent-org/src/diag/events';

import type { CoreContext, CoreDefinition, CoreInstance } from '../../core';
import { agentConfigValidator, agentDefaultConfig, type AgentConfig } from './config';
import { describeRecord } from './describe';
import { judgeHealth } from './health';
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

  get diagSource(): DiagSource | undefined {
    return this.source;
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

export const agentCore: CoreDefinition<AgentConfig, AgentCore> = {
  id: 'agent',
  kind: 'passive',
  title: '에이전트 진단',
  configSchema: agentConfigValidator,
  defaultConfig: agentDefaultConfig,
  faults: [],
  create: (ctx) => new AgentCore(ctx),
};
