/**
 * Runs: start, end, the one-open-Run rule and Run meta
 * (docs/testbed/runs-and-checks.md §1).
 *
 * While a Run is open the bus stamps its id on every event, and those events
 * go to the store and into the Run's summary. Lease checks and
 * `configOverrides` belong to the control service, which calls this.
 */
import type { Caller } from '@shared/testbed/events';
import type { RunEndReason, RunMeta } from '@shared/testbed/runs';
import { nowUtc, type UtcIsoString } from '@shared/time';

import { TestbedError } from '../errors';
import type { EventBus } from '../events/bus';
import { generateSeed, SeededRng } from '../rng';
import type { RunStore } from './store';
import { SummaryBuilder } from './summary';

export interface StartRunInput {
  label: string;
  seed?: string;
  /** Close the open Run (`endReason: 'replaced'`) instead of failing with `RUN_ACTIVE`. */
  endActive?: boolean;
  /** Every core's config at start, overrides applied — supplied by the control service. */
  configSnapshot?: Record<string, unknown>;
}

function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 4);
}

/** `14:02` — the hour and minute (UTC) a Run was opened, for error messages. */
function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

export class RunManager {
  private open: { meta: RunMeta; summary: SummaryBuilder; rng: SeededRng } | null = null;
  private nextNumber = 1;
  private readonly bootRng: SeededRng;
  private readonly now: () => UtcIsoString;

  constructor(
    private readonly bus: EventBus,
    private readonly store: RunStore,
    options: { bootSeed?: string; now?: () => UtcIsoString } = {},
  ) {
    this.bootRng = new SeededRng(options.bootSeed ?? generateSeed());
    this.now = options.now ?? nowUtc;
    bus.subscribe((event) => {
      if (event.runId === null || event.runId !== this.open?.meta.runId) return;
      this.open.summary.add(event);
      this.store.append(event);
    });
  }

  /** The open Run's meta, or `null`. */
  active(): RunMeta | null {
    return this.open ? structuredClone(this.open.meta) : null;
  }

  /** The seed of this boot (used outside a Run). */
  bootSeed(): string {
    return this.bootRng.seed;
  }

  /** The open Run's rng, or the boot rng outside a Run (docs/testbed/faults-and-seed.md §2). */
  rng(): SeededRng {
    return this.open?.rng ?? this.bootRng;
  }

  async start(input: StartRunInput, caller: Caller): Promise<RunMeta> {
    if (this.open) {
      if (!input.endActive) {
        const { runId, label, openedBy, startedAt } = this.open.meta;
        throw new TestbedError(
          'RUN_ACTIVE',
          `Run이 이미 열려 있음(${runId}, '${label}', 연 쪽 ${openedBy.actor}, ${hhmm(startedAt)} UTC에 엶). 닫고 새로 시작하려면 start_run에 endActive: true`,
          { runId, label, openedBy, startedAt },
        );
      }
      await this.end(caller, 'replaced');
    }

    const seed = input.seed ?? generateSeed();
    const meta: RunMeta = {
      runId: `run-${this.nextNumber}-${randomSuffix()}`,
      label: input.label,
      instanceId: this.bus.instanceId,
      seed,
      configSnapshot: input.configSnapshot ?? {},
      openedBy: caller,
      startedAt: this.now(),
    };
    this.nextNumber += 1;
    await this.store.create(meta);
    this.open = { meta, summary: new SummaryBuilder(), rng: new SeededRng(seed) };
    this.bus.currentRunId = meta.runId;
    this.bus.emit({
      core: 'testbed',
      kind: 'testbed.run.started',
      actor: caller.actor,
      caller,
      summary: `run ${meta.runId} '${meta.label}' started by ${caller.actor} (seed ${seed})`,
      payload: { runId: meta.runId, label: meta.label, seed, openedBy: caller },
    });
    return structuredClone(meta);
  }

  /** Closes the open Run and returns its final meta (with summary), or `null` if none was open. */
  async end(caller: Caller, reason: RunEndReason = 'ended'): Promise<RunMeta | null> {
    const open = this.open;
    if (!open) return null;
    this.bus.emit({
      core: 'testbed',
      kind: 'testbed.run.ended',
      actor: caller.actor,
      caller,
      summary: `run ${open.meta.runId} ended by ${caller.actor} (${reason})`,
      payload: { runId: open.meta.runId, endReason: reason, endedBy: caller },
    });
    this.open = null;
    this.bus.currentRunId = null;

    const endedAt = this.now();
    const meta: RunMeta = {
      ...open.meta,
      endedBy: caller,
      endReason: reason,
      endedAt,
      summary: open.summary.build(open.meta.startedAt, endedAt),
    };
    await this.store.close(meta);
    return structuredClone(meta);
  }
}
