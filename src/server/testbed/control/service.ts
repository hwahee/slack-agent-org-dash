/**
 * The control service — the one source of truth for operating and observing
 * the testbed (docs/testbed/control-plane.md §1). REST, MCP and WS are thin
 * adapters over these functions; nothing is implemented twice.
 *
 * Every function takes the `caller`. Reads go through the lease only to
 * extend it for its holder; operations need the lease (or no one holding it)
 * and leave a `testbed.control.invoked` event with their outcome.
 */
import type { CoreLog, TestbedManifest, TestbedStatus } from '@shared/testbed/control';
import type { CoreStatus } from '@shared/testbed/core';
import {
  matchesFilter,
  type Caller,
  type EventFilter,
  type TestbedEvent,
} from '@shared/testbed/events';
import type { RunMeta } from '@shared/testbed/runs';

import { NotFoundError } from '../../lib/errors';
import type { BaseCoreConfig } from '../core';
import { TestbedError } from '../errors';
import { queryLimit } from '../events/filter';
import { runCheck, type CheckInput, type CheckResult } from '../runs/check';
import type { TestbedRuntime } from '../runtime';
import { publicCaller } from './caller';
import type { LeaseManager } from './lease';

const ALL_CORES = '_all';
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 120_000;
const INPUT_SUMMARY_CHARS = 200;

export interface ManifestInfo {
  name: string;
  version: string;
  baseVersion: string;
  /** `bearer` when `TESTBED_CONTROL_TOKEN` is set. */
  authControl: 'none' | 'bearer';
  runStore: 'memory' | 'file';
  /** `TESTBED_PUBLIC_URL`, for addresses handed to callers. */
  publicUrl: string;
}

export interface StartRunRequest {
  label: string;
  seed?: string;
  configOverrides?: Record<string, Record<string, unknown>>;
  endActive?: boolean;
}

export interface WaitRequest {
  filter: EventFilter;
  /** Default 1. */
  count?: number;
  /** Default 30 s, at most 120 s. */
  timeoutMs?: number;
}

function summarizeInput(input: unknown): string {
  const json = JSON.stringify(input) ?? '';
  return json.length > INPUT_SUMMARY_CHARS ? `${json.slice(0, INPUT_SUMMARY_CHARS)}…` : json;
}

function errorCode(error: unknown): string {
  if (error instanceof TestbedError) return error.code;
  if (error instanceof Error) return error.name;
  return 'Error';
}

export class ControlService {
  /** The configs `configOverrides` replaced, put back when the Run closes. */
  private overridden = new Map<string, BaseCoreConfig>();

  constructor(
    private readonly rt: TestbedRuntime,
    readonly lease: LeaseManager,
    private readonly info: ManifestInfo,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  getManifest(caller: Caller): TestbedManifest {
    this.read(caller, 'getManifest');
    const { host, bus } = this.rt;
    return {
      name: this.info.name,
      version: this.info.version,
      instanceId: bus.instanceId,
      baseVersion: this.info.baseVersion,
      publicUrl: this.info.publicUrl,
      cores: host.describeAll().map((core) => {
        const status = host.status(core.id);
        return {
          id: core.id,
          kind: core.kind,
          title: core.title,
          state: status.state,
          external: core.external,
          replicas: core.replicas,
          endpoints: status.endpoints,
          actions: core.actions,
          configSchema: core.configSchema,
          faults: core.faults,
        };
      }),
      control: { rest: '/testbed/api', mcp: '/testbed/mcp', ws: '/testbed/ws' },
      auth: { control: this.info.authControl },
      features: { runStore: this.info.runStore, seed: true },
    };
  }

  getStatus(caller: Caller): TestbedStatus {
    this.read(caller, 'getStatus');
    return this.status();
  }

  /** External cores' counters or endpoints moved (WS pushes the status). */
  onStatusChanged(listener: () => void): () => void {
    return this.rt.host.onStatusChanged(listener);
  }

  /** The status without touching the lease (WS pushes). */
  status(): TestbedStatus {
    return {
      instanceId: this.rt.bus.instanceId,
      cores: this.rt.host.statusAll(),
      run: this.rt.runs.active(),
      lease: this.lease.view(),
    };
  }

  /** Each replica's latest stderr lines (masked); `replica` picks one. */
  getCoreLog(core: string, caller: Caller, replica?: string): CoreLog {
    this.read(caller, 'getCoreLog');
    return this.rt.host.logs(core, replica);
  }

  getConfig(core: string, caller: Caller): BaseCoreConfig {
    this.read(caller, 'getConfig');
    return this.rt.host.getConfig(core);
  }

  async listRuns(caller: Caller): Promise<RunMeta[]> {
    this.read(caller, 'listRuns');
    return this.rt.store.list();
  }

  async getRun(runId: string, caller: Caller): Promise<RunMeta> {
    this.read(caller, 'getRun');
    const meta = await this.rt.store.get(runId);
    if (!meta) throw new NotFoundError('run', runId);
    return meta;
  }

  /**
   * Events matching the filter, oldest first, plus the cursor to continue
   * from. A closed (or earlier-boot) Run is read from the Run store; anything
   * else from the ring buffer.
   */
  async queryEvents(
    filter: EventFilter,
    caller: Caller,
  ): Promise<{ events: TestbedEvent[]; cursor: string | null; total: number }> {
    this.read(caller, 'queryEvents');
    const open = this.rt.runs.active();
    let page: { events: TestbedEvent[]; total: number };
    if (filter.runId !== undefined && filter.runId !== 'current' && filter.runId !== open?.runId) {
      const stored = await this.rt.store.events(filter.runId);
      const start =
        filter.after === undefined ? 0 : stored.findIndex((e) => e.id === filter.after) + 1;
      const matching = stored.slice(start).filter((event) => matchesFilter(event, filter));
      page = { events: matching.slice(0, queryLimit(filter)), total: matching.length };
    } else {
      page = this.rt.bus.page(filter);
    }
    return { ...page, cursor: page.events.at(-1)?.id ?? filter.after ?? null };
  }

  getEvent(id: string, caller: Caller): TestbedEvent {
    this.read(caller, 'getEvent');
    const event = this.rt.bus.buffered().find((candidate) => candidate.id === id);
    if (!event) throw new NotFoundError('event', id);
    return event;
  }

  /**
   * Waits until `count` events matching the filter have come (after the
   * `after` cursor if given, else from now), or the time is up — then returns
   * what it has.
   */
  async waitFor(
    request: WaitRequest,
    caller: Caller,
  ): Promise<{ events: TestbedEvent[]; timedOut: boolean }> {
    this.read(caller, 'waitFor');
    const { filter } = request;
    const count = Math.max(1, request.count ?? 1);
    const timeoutMs = Math.min(Math.max(0, request.timeoutMs ?? DEFAULT_WAIT_MS), MAX_WAIT_MS);
    const matched =
      filter.after === undefined ? [] : this.rt.bus.query({ ...filter, limit: count });
    if (matched.length >= count) return { events: matched.slice(0, count), timedOut: false };

    const wanted = (event: TestbedEvent) => {
      if (filter.runId !== undefined) {
        const runId = filter.runId === 'current' ? this.rt.runs.active()?.runId : filter.runId;
        if (event.runId !== runId) return false;
      }
      return matchesFilter(event, filter);
    };
    return new Promise((resolve) => {
      const finish = (timedOut: boolean) => {
        clearTimeout(timer);
        unsubscribe();
        resolve({ events: matched, timedOut });
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      const unsubscribe = this.rt.bus.subscribe((event) => {
        if (!wanted(event)) return;
        matched.push(event);
        if (matched.length >= count) finish(false);
      });
    });
  }

  async check(input: CheckInput, caller: Caller): Promise<CheckResult> {
    this.read(caller, 'check');
    return runCheck(this.rt, input, caller);
  }

  /** The Run's events as JSONL, one event per line. */
  async exportRun(runId: string, caller: Caller): Promise<string> {
    this.read(caller, 'exportRun');
    if (!(await this.rt.store.get(runId))) throw new NotFoundError('run', runId);
    const events = await this.rt.store.events(runId);
    return events.map((event) => `${JSON.stringify(event)}\n`).join('');
  }

  /**
   * Where to fetch a Run's export, without its body: the URL (under
   * `TESTBED_PUBLIC_URL`) and, with the file store, the JSONL path. No
   * `runId` → the open Run, else the Run that closed last.
   */
  async exportLocation(
    runId: string | undefined,
    caller: Caller,
  ): Promise<{ runId: string; url: string; path?: string }> {
    this.read(caller, 'exportLocation');
    const id = runId ?? this.rt.runs.active()?.runId ?? (await this.lastClosedRun());
    if (id === undefined || !(await this.rt.store.get(id))) {
      throw new NotFoundError('run', runId ?? 'latest');
    }
    const url = new URL(`/testbed/api/runs/${encodeURIComponent(id)}/export`, this.info.publicUrl)
      .href;
    const path = this.rt.store.location(id);
    return { runId: id, url, ...(path === undefined ? {} : { path }) };
  }

  // ── Operations ───────────────────────────────────────────────────────────

  setConfig(core: string, patch: Record<string, unknown>, caller: Caller) {
    return this.operate('setConfig', caller, { core, patch }, async () => {
      const result = await this.rt.host.setConfig(core, patch);
      return { result, config: this.rt.host.getConfig(core) };
    });
  }

  start(core: string, caller: Caller): Promise<CoreStatus[]> {
    return this.operate('start', caller, { core }, () =>
      this.eachCore(core, (id) => this.rt.host.start(id)),
    );
  }

  stop(core: string, caller: Caller): Promise<CoreStatus[]> {
    return this.operate('stop', caller, { core }, () =>
      this.eachCore(core, (id) => this.rt.host.stop(id)),
    );
  }

  reset(core: string, caller: Caller): Promise<CoreStatus[]> {
    return this.operate('reset', caller, { core }, () =>
      this.eachCore(core, (id) => this.rt.host.reset(id)),
    );
  }

  startRun(request: StartRunRequest, caller: Caller): Promise<RunMeta> {
    return this.operate('startRun', caller, request, async () => {
      const open = this.rt.runs.active();
      if (open && request.endActive) await this.closeRun(caller, 'replaced');
      if (this.rt.runs.active()) {
        // Let the Run manager raise RUN_ACTIVE with the open Run's details.
        return this.rt.runs.start({ label: request.label }, publicCaller(caller));
      }
      await this.applyOverrides(request.configOverrides ?? {});
      const configSnapshot = Object.fromEntries(
        this.rt.host.ids().map((id) => [id, this.rt.host.getConfig(id)]),
      );
      return this.rt.runs.start(
        {
          label: request.label,
          ...(request.seed === undefined ? {} : { seed: request.seed }),
          configSnapshot,
        },
        publicCaller(caller),
      );
    });
  }

  endRun(caller: Caller): Promise<RunMeta> {
    return this.operate('endRun', caller, {}, async () => {
      const ended = await this.closeRun(caller, 'ended');
      if (!ended) throw new NotFoundError('run', 'current');
      return ended;
    });
  }

  /**
   * Runs a core action. `replica` picks one replica of an external core;
   * without it every replica runs it (docs/testbed/external-core-protocol.md §6).
   */
  invokeAction(
    core: string,
    name: string,
    input: unknown,
    caller: Caller,
    replica?: string,
  ): Promise<unknown> {
    const mutating = this.rt.host.actionMutating(core, name) ?? true;
    const fn = `${core}.${name}`;
    if (!mutating) {
      this.read(caller, fn);
      return this.rt.host.invokeAction(core, name, input, caller, replica);
    }
    const recorded = replica === undefined ? input : { input, replica };
    return this.operate(fn, caller, recorded, () =>
      this.rt.host.invokeAction(core, name, input, caller, replica),
    );
  }

  /**
   * For a NOT_FOUND message: the ids that do exist (`core` → core ids,
   * `action` with `<core>.<name>` → that core's actions). `undefined` when
   * there is no short list to give (events, Runs).
   */
  knownIds(resource: string, id: string): string[] | undefined {
    const { host } = this.rt;
    if (resource === 'core') return host.ids();
    if (resource === 'action') {
      const core = id.slice(0, id.lastIndexOf('.'));
      if (!host.ids().includes(core)) return host.ids();
      return host.describe(core).actions.map((action) => `${core}.${action.name}`);
    }
    return undefined;
  }

  // ── Lease ────────────────────────────────────────────────────────────────

  acquireLease(caller: Caller) {
    return this.lease.acquire(caller);
  }

  releaseLease(caller: Caller): { released: boolean } {
    return { released: this.lease.release(caller) };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async lastClosedRun(): Promise<string | undefined> {
    const closed = (await this.rt.store.list()).filter((meta) => meta.endedAt !== undefined);
    closed.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
    return closed[0]?.runId;
  }

  private read(caller: Caller, fn: string): void {
    this.lease.authorize(caller, fn, false);
  }

  private async operate<T>(
    fn: string,
    caller: Caller,
    input: unknown,
    body: () => Promise<T>,
  ): Promise<T> {
    const acquired = this.lease.authorize(caller, fn, true);
    const recorded = publicCaller(caller);
    try {
      const result = await body();
      this.invoked(fn, recorded, input, 'ok');
      return result;
    } catch (error) {
      this.invoked(fn, recorded, input, errorCode(error));
      if (acquired) this.lease.undoAcquire(caller);
      throw error;
    }
  }

  private invoked(fn: string, caller: Caller, input: unknown, result: string): void {
    const summary = summarizeInput(input);
    this.rt.bus.emit({
      core: 'testbed',
      kind: 'testbed.control.invoked',
      level: result === 'ok' ? 'info' : 'warn',
      actor: caller.actor,
      summary: `${caller.actor} ${fn} ${result === 'ok' ? 'ok' : `failed (${result})`}`.slice(
        0,
        200,
      ),
      payload: { fn, input: summary, caller, result },
    });
  }

  private async eachCore(
    core: string,
    act: (id: string) => Promise<CoreStatus>,
  ): Promise<CoreStatus[]> {
    const ids = core === ALL_CORES ? this.rt.host.ids() : [core];
    const out: CoreStatus[] = [];
    for (const id of ids) out.push(await act(id));
    return out;
  }

  /** Applies a Run's overrides; any that would need a restart undoes them all. */
  private async applyOverrides(overrides: Record<string, Record<string, unknown>>): Promise<void> {
    const before = new Map<string, BaseCoreConfig>();
    try {
      for (const [core, patch] of Object.entries(overrides)) {
        const previous = this.rt.host.getConfig(core);
        before.set(core, previous);
        if ((await this.rt.host.setConfig(core, patch)) === 'restart-required') {
          throw new TestbedError(
            'RESTART_REQUIRED',
            `configOverrides의 ${core} 설정은 재시작이 필요해 Run에 바로 적용할 수 없음. set_config 후 stop → start 하고 Run을 시작`,
            { core, patch },
          );
        }
      }
    } catch (error) {
      for (const [core, previous] of before) await this.rt.host.setConfig(core, { ...previous });
      throw error;
    }
    this.overridden = before;
  }

  /** Ends the open Run and puts back what its overrides replaced. */
  private async closeRun(caller: Caller, reason: 'ended' | 'replaced'): Promise<RunMeta | null> {
    const ended = await this.rt.runs.end(publicCaller(caller), reason);
    for (const [core, previous] of this.overridden) {
      await this.rt.host.setConfig(core, { ...previous });
    }
    this.overridden = new Map();
    return ended;
  }
}
