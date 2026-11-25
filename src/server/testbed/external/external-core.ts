/**
 * An external core as the core host sees it
 * (docs/testbed/external-core-protocol.md): its processes (replicas), what
 * their `initialize` said, its config (the core's part checked with the
 * core's schema, the glue's part with §2.1), its state, and every request
 * and notification in between.
 */
import type { CoreEndpoint, CoreKind, CoreState, FaultKind } from '@shared/testbed/core';
import type { Actor, Caller, EventLevel } from '@shared/testbed/events';
import { ValidationError, type ValidationIssue } from '@shared/validation';

import { NotFoundError } from '../../lib/errors';
import type { Logger } from '../../lib/log';
import { publicCaller } from '../control/caller';
import type { BaseCoreConfig } from '../core';
import { TestbedError } from '../errors';
import type { EventBus } from '../events/bus';
import { redactText } from '../redact';
import type { RunManager } from '../runs/runs';
import {
  GLUE_KEYS,
  glueConfigValidator,
  glueDefaults,
  processEnv,
  type ExternalCoreDefinition,
  type GlueConfig,
} from './define';
import { fromCoreCall } from './errors';
import { checkInitialize, PROTOCOL_VERSION, type CoreSpec } from './initialize';
import { StdioRpc } from './rpc';

/** stderr lines kept per replica (protocol §7). */
const STDERR_KEPT = 50;
const CORE_STATES: readonly CoreState[] = [
  'idle',
  'starting',
  'running',
  'stopping',
  'stopped',
  'error',
];
const ACTORS: readonly Actor[] = ['product', 'human', 'agent', 'ci', 'system'];
const LEVELS: readonly EventLevel[] = ['debug', 'info', 'warn', 'error'];
/** The overall state is the first of these any replica is in (protocol §6). */
const PRECEDENCE: readonly CoreState[] = [
  'error',
  'starting',
  'stopping',
  'stopped',
  'idle',
  'running',
];

export interface ExternalCoreDeps {
  bus: EventBus;
  runs: RunManager;
  log: Logger;
  /** Where `<CORE_ID>_*` and the passed-through variables come from. */
  env: Record<string, string | undefined>;
  /** The processes' working directory (the repository root). */
  cwd: string;
}

interface Replica {
  id: string;
  index: number;
  state: CoreState;
  detail?: string;
  rpc?: StdioRpc;
  pid?: number;
  /** The process got `initialize` and `applyConfig` right. */
  ready: boolean;
  /** The glue asked it to end (shutdown, kill) — its exit is expected. */
  ending: boolean;
  stderr: string[];
  endpoints: CoreEndpoint[];
  counters: Record<string, number>;
  ping?: ReturnType<typeof setInterval>;
}

function errorDetail(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error instanceof Error ? `${error.code}: ${error.message}` : error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The fault kinds a rule uses. */
function kindsOf(rule: Record<string, unknown>): FaultKind[] {
  const kinds: FaultKind[] = [];
  if (rule.delayMs !== undefined) kinds.push('delay');
  if (rule.error !== undefined) kinds.push('error');
  if (rule.disconnect === true) kinds.push('disconnect');
  if (rule.corrupt === true) kinds.push('corrupt');
  return kinds;
}

export class ExternalCore {
  readonly id: string;
  readonly kind: CoreKind;
  readonly title: string;
  private spec: CoreSpec | null = null;
  /** The core's part of the config, checked with its schema; `null` until the first `initialize`. */
  private coreConfig: Record<string, unknown> | null = null;
  private glue: GlueConfig;
  private replicas: Replica[] = [];
  private overall: CoreState = 'idle';
  private initProblem: string | undefined;

  constructor(
    readonly definition: ExternalCoreDefinition,
    private readonly deps: ExternalCoreDeps,
  ) {
    this.id = definition.id;
    this.kind = definition.kind;
    this.title = definition.title;
    this.glue = glueDefaults(definition.id, deps.env);
    this.replicas = this.makeReplicas(this.glue.replicas);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Boot: every replica spawned, initialized and configured (not started). */
  async init(): Promise<void> {
    for (const replica of this.replicas) await this.bringUp(replica);
  }

  /** Whether the config says to start at boot. */
  autoStart(): boolean {
    return this.coreConfig?.autoStart === true;
  }

  async start(): Promise<void> {
    for (const replica of this.replicas) {
      if (!replica.ready && !(await this.bringUp(replica))) continue;
      if (replica.state === 'running' || replica.state === 'starting') continue;
      this.setReplicaState(replica, 'starting');
      try {
        await this.call(replica, 'start', {});
        this.setReplicaState(replica, 'running');
        await this.refresh(replica);
      } catch (error) {
        this.setReplicaState(
          replica,
          'error',
          errorDetail(fromCoreCall(this.id, replica.id, error)),
        );
      }
    }
  }

  async stop(): Promise<void> {
    for (const replica of this.replicas) {
      if (replica.state !== 'running' || !replica.ready) continue;
      this.setReplicaState(replica, 'stopping');
      try {
        await this.call(replica, 'stop', {});
        this.setReplicaState(replica, 'stopped');
        await this.refresh(replica);
      } catch (error) {
        this.setReplicaState(
          replica,
          'error',
          errorDetail(fromCoreCall(this.id, replica.id, error)),
        );
      }
    }
  }

  async reset(): Promise<void> {
    for (const replica of this.liveReplicas()) {
      await this.call(replica, 'reset', {}).catch((error: unknown) => {
        throw fromCoreCall(this.id, replica.id, error);
      });
      await this.refresh(replica);
    }
  }

  /** The Run changed: every replica gets its own seed `<seed>:<replicaId>` (protocol §4.3). */
  async runChanged(runId: string | null, seed: string): Promise<void> {
    await Promise.all(
      this.liveReplicas().map((replica) =>
        this.call(replica, 'runChanged', { runId, seed: `${seed}:${replica.id}` }).catch(
          (error: unknown) => {
            this.deps.log.warn('external core runChanged failed', {
              core: this.id,
              replica: replica.id,
              error: errorDetail(error),
            });
          },
        ),
      ),
    );
  }

  /** Server shutdown: `shutdown`, then SIGTERM, then SIGKILL (protocol §8). */
  async shutdown(): Promise<void> {
    await Promise.all(this.replicas.map((replica) => this.endProcess(replica)));
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  state(): { state: CoreState; detail?: string } {
    const detail =
      this.overall === 'error'
        ? (this.replicas.find((replica) => replica.state === 'error')?.detail ?? this.initProblem)
        : undefined;
    return { state: this.overall, ...(detail === undefined ? {} : { detail }) };
  }

  status(): { endpoints: CoreEndpoint[]; counters: Record<string, number> } {
    const counters: Record<string, number> = {};
    for (const replica of this.replicas) {
      for (const [name, value] of Object.entries(replica.counters)) {
        counters[name] = (counters[name] ?? 0) + value;
      }
    }
    return { endpoints: this.replicas.flatMap((replica) => replica.endpoints), counters };
  }

  getConfig(): BaseCoreConfig & GlueConfig {
    const core = this.coreConfig ?? {
      autoStart: this.kind === 'passive',
      eventLevel: 'info',
      faults: [],
    };
    return structuredClone({ ...core, ...this.glue }) as BaseCoreConfig & GlueConfig;
  }

  /** For the manifest: exactly what `initialize` said (nothing before it succeeds). */
  describe(): {
    configSchema: Record<string, unknown>;
    actions: {
      name: string;
      title: string;
      description: string;
      mutating: boolean;
      surfaces: ('rest' | 'mcp' | 'ui')[];
      inputSchema: Record<string, unknown>;
    }[];
    faults: FaultKind[];
  } {
    const spec = this.spec;
    if (!spec) return { configSchema: {}, actions: [], faults: [] };
    return {
      configSchema: structuredClone(spec.configSchema),
      actions: Object.entries(spec.actions).map(([name, action]) => ({
        name,
        title: action.title,
        description: action.description,
        mutating: action.mutating,
        surfaces: [...action.surfaces],
        inputSchema: structuredClone(action.inputSchema),
      })),
      faults: [...spec.faults],
    };
  }

  /** Whether the action needs the lease (`undefined` for an unknown action). */
  actionMutating(name: string): boolean | undefined {
    return this.spec?.actions[name]?.mutating;
  }

  /** stderr lines kept per replica (masked). */
  logs(): { replica: string; lines: string[] }[] {
    return this.replicas.map((replica) => ({ replica: replica.id, lines: [...replica.stderr] }));
  }

  // ── Config ────────────────────────────────────────────────────────────────

  /**
   * A partial patch: glue fields checked against protocol §2.1, the rest
   * against the core's own schema. Stored either way; `restart-required`
   * when a replica says so or `replicas` changed.
   */
  async setConfig(patch: Record<string, unknown>): Promise<'applied' | 'restart-required'> {
    const gluePatch: Record<string, unknown> = {};
    const corePatch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if ((GLUE_KEYS as readonly string[]).includes(key)) gluePatch[key] = value;
      else corePatch[key] = value;
    }
    const glue = glueConfigValidator.parse({ ...this.glue, ...gluePatch });
    let core = this.coreConfig;
    if (Object.keys(corePatch).length > 0) {
      if (!this.spec || !core) {
        throw new ValidationError([
          {
            path: '',
            message: `the config schema of ${this.id} is unknown until its process initializes (${this.initProblem ?? 'not started'})`,
            code: 'not_initialized',
          },
        ]);
      }
      core = this.validateCore({ ...core, ...corePatch });
    }
    const replicasChanged = glue.replicas !== this.glue.replicas;
    this.glue = glue;
    if (core === this.coreConfig) return replicasChanged ? 'restart-required' : 'applied';
    this.coreConfig = core;
    let result: 'applied' | 'restart-required' = replicasChanged ? 'restart-required' : 'applied';
    for (const replica of this.liveReplicas()) {
      try {
        const answer = await this.call(replica, 'applyConfig', { config: core });
        if (isObject(answer) && answer.result === 'restart-required') result = 'restart-required';
      } catch (error) {
        throw fromCoreCall(this.id, replica.id, error);
      }
    }
    return result;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async invokeAction(name: string, input: unknown, caller: Caller): Promise<unknown> {
    const action = this.spec?.actions[name];
    if (!action) throw new NotFoundError('action', `${this.id}.${name}`);
    const parsed = action.input.parse(input ?? {});
    if (this.overall !== 'running') {
      throw new TestbedError(
        'CORE_NOT_RUNNING',
        `코어 ${this.id}가 running이 아님(${this.overall}). start 후 다시 시도`,
        { core: this.id, state: this.overall },
      );
    }
    const replica = this.replicas[0];
    if (!replica) throw new TestbedError('CORE_NOT_RUNNING', `코어 ${this.id}에 복제가 없음`);
    let output: unknown;
    try {
      output = await this.call(replica, 'action', {
        name,
        input: parsed,
        caller: publicCaller(caller),
      });
    } catch (error) {
      throw fromCoreCall(this.id, replica.id, error);
    }
    const checked = action.output.safeParse(output);
    if (!checked.ok) {
      throw new TestbedError(
        'CORE_ERROR',
        `코어 ${this.id}의 액션 ${name} 출력이 outputSchema와 맞지 않음`,
        { core: this.id, replica: replica.id, coreCode: 'BAD_OUTPUT', issues: checked.issues },
      );
    }
    return checked.value;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private makeReplicas(count: number): Replica[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `r${index}`,
      index,
      state: 'idle',
      ready: false,
      ending: false,
      stderr: [],
      endpoints: [],
      counters: {},
    }));
  }

  private liveReplicas(): Replica[] {
    return this.replicas.filter(
      (replica) => replica.ready && replica.rpc !== undefined && !replica.rpc.exited,
    );
  }

  private call(
    replica: Replica,
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const rpc = replica.rpc;
    if (!rpc) return Promise.reject(new Error(`replica ${replica.id} has no process`));
    return rpc.request(method, params, timeoutMs ?? this.glue.requestTimeoutMs);
  }

  /** Spawn → initialize → check → applyConfig. False (and `error`) on any failure. */
  private async bringUp(replica: Replica): Promise<boolean> {
    if (replica.rpc && !replica.rpc.exited) await this.endProcess(replica);
    replica.ready = false;
    replica.ending = false;
    replica.endpoints = [];
    replica.counters = {};
    const fail = async (detail: string) => {
      if (replica.index === 0 && !this.spec) this.initProblem = detail;
      await this.endProcess(replica);
      this.setReplicaState(replica, 'error', detail);
      return false;
    };

    let rpc: StdioRpc;
    try {
      rpc = StdioRpc.spawn(this.definition.command, {
        cwd: this.deps.cwd,
        env: processEnv(this.definition, this.deps.env),
        handlers: {
          notification: (method, params) => this.onNotification(replica, method, params),
          stderr: (line) => this.onStderr(replica, line),
          dropped: (reason, preview) => {
            this.deps.log.warn('external core wrote a non-protocol line to stdout', {
              core: this.id,
              replica: replica.id,
              reason,
              preview: redactText(preview),
            });
          },
          exit: (code, signal) => this.onExit(replica, rpc, code, signal),
        },
      });
    } catch (error) {
      return fail(`spawn failed: ${errorDetail(error)}`);
    }
    replica.rpc = rpc;
    replica.pid = rpc.pid;
    this.deps.bus.emit({
      core: this.id,
      replica: replica.id,
      kind: 'testbed.core.process.spawned',
      actor: 'system',
      summary: `${this.id} ${replica.id} spawned (pid ${rpc.pid})`,
      payload: { pid: rpc.pid, command: [...this.definition.command] },
    });

    const run = this.deps.runs.active();
    let answer: unknown;
    try {
      answer = await this.call(replica, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        coreId: this.id,
        replicaId: replica.id,
        replicaIndex: replica.index,
        replicas: this.replicas.length,
        seed: `${this.deps.runs.rng().seed}:${replica.id}`,
        runId: run?.runId ?? null,
      });
    } catch (error) {
      return fail(`initialize failed: ${errorDetail(fromCoreCall(this.id, replica.id, error))}`);
    }

    const spec = checkInitialize(answer, this.definition);
    if (typeof spec === 'string') return fail(spec);
    if (this.spec && spec.raw !== this.spec.raw) {
      return fail(`initialize answer differs from r0's`);
    }
    if (!this.spec) {
      this.spec = spec;
      try {
        // First boot: the core's own defaults (from its env) on top of nothing.
        this.coreConfig ??= this.validateCore(spec.defaultConfig);
      } catch (error) {
        this.spec = null;
        return fail(`defaultConfig does not fit configSchema: ${errorDetail(error)}`);
      }
      this.initProblem = undefined;
    }

    try {
      await this.call(replica, 'applyConfig', { config: this.coreConfig });
    } catch (error) {
      return fail(`applyConfig failed: ${errorDetail(fromCoreCall(this.id, replica.id, error))}`);
    }
    replica.ready = true;
    this.setReplicaState(replica, 'idle');
    this.startPing(replica);
    return true;
  }

  private validateCore(raw: Record<string, unknown>): Record<string, unknown> {
    const spec = this.spec;
    if (!spec) throw new Error('no config schema yet');
    const config = spec.config.parse(raw) as Record<string, unknown>;
    const faults = Array.isArray(config.faults) ? (config.faults as Record<string, unknown>[]) : [];
    const issues: ValidationIssue[] = [];
    faults.forEach((rule, index) => {
      for (const kind of kindsOf(rule)) {
        if (!spec.faults.includes(kind)) {
          issues.push({
            path: `faults.${index}`,
            message: `fault '${kind}' is not supported by this core (supported: ${spec.faults.join(', ') || 'none'})`,
            code: 'unsupported_fault',
          });
        }
      }
    });
    if (issues.length > 0) throw new ValidationError(issues);
    return config;
  }

  /** Asks the process for its status and keeps endpoints and counters. */
  private async refresh(replica: Replica): Promise<void> {
    if (!replica.ready) return;
    try {
      const answer = await this.call(replica, 'status', {}, this.glue.pingTimeoutMs);
      this.takeStatus(replica, answer);
    } catch {
      // The supervisor judges silence; a status that does not come is not an error here.
    }
  }

  private takeStatus(replica: Replica, answer: unknown): void {
    if (!isObject(answer)) return;
    if (Array.isArray(answer.endpoints)) {
      replica.endpoints = answer.endpoints.filter(
        (endpoint): endpoint is CoreEndpoint =>
          isObject(endpoint) &&
          typeof endpoint.name === 'string' &&
          typeof endpoint.protocol === 'string' &&
          typeof endpoint.url === 'string',
      );
    }
    if (isObject(answer.counters)) {
      replica.counters = Object.fromEntries(
        Object.entries(answer.counters).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      );
    }
  }

  private startPing(replica: Replica): void {
    clearInterval(replica.ping);
    replica.ping = setInterval(() => void this.refresh(replica), this.glue.pingIntervalMs);
    replica.ping.unref();
  }

  private async endProcess(replica: Replica): Promise<void> {
    clearInterval(replica.ping);
    const rpc = replica.rpc;
    if (!rpc || rpc.exited) return;
    replica.ending = true;
    const grace = this.glue.shutdownGraceMs;
    // The grace period counts from `shutdown` being sent, answered or not.
    void rpc.request('shutdown', {}, Math.max(grace, 100)).catch(() => undefined);
    if (await rpc.waitExit(grace)) return;
    rpc.kill('SIGTERM');
    if (await rpc.waitExit(grace)) return;
    rpc.kill('SIGKILL');
    await rpc.waitExit(5000);
  }

  private onExit(
    replica: Replica,
    rpc: StdioRpc,
    code: number | null,
    signal: string | null,
  ): void {
    if (replica.rpc !== rpc) return;
    clearInterval(replica.ping);
    replica.ready = false;
    if (replica.ending) return;
    this.setReplicaState(replica, 'error', `exited (${signal ?? `code ${code ?? '?'}`})`);
  }

  private onStderr(replica: Replica, line: string): void {
    const masked = redactText(line);
    replica.stderr.push(masked);
    if (replica.stderr.length > STDERR_KEPT)
      replica.stderr.splice(0, replica.stderr.length - STDERR_KEPT);
    this.deps.log.info('external core stderr', {
      core: this.id,
      replica: replica.id,
      line: masked,
    });
  }

  private onNotification(replica: Replica, method: string, params: unknown): void {
    if (!isObject(params)) {
      this.deps.log.warn('external core notification without params', { core: this.id, method });
      return;
    }
    switch (method) {
      case 'event':
        this.onEvent(replica, params);
        return;
      case 'fault': {
        const ruleId = typeof params.ruleId === 'string' ? params.ruleId : '?';
        const effects = isObject(params.effects) ? params.effects : {};
        const correlationId =
          typeof params.correlationId === 'string' ? params.correlationId : undefined;
        this.deps.bus.emit({
          core: 'testbed',
          replica: replica.id,
          kind: 'testbed.fault.injected',
          level: 'warn',
          actor: 'system',
          ...(correlationId === undefined ? {} : { correlationId }),
          summary: `fault ${ruleId} on ${this.id} ${replica.id}: ${Object.keys(effects).join('+') || 'none'}`,
          payload: {
            core: this.id,
            replica: replica.id,
            ruleId,
            effects,
            selector: isObject(params.selector) ? params.selector : {},
          },
        });
        return;
      }
      case 'state': {
        const state = params.state;
        if (typeof state === 'string' && CORE_STATES.includes(state as CoreState)) {
          this.setReplicaState(
            replica,
            state as CoreState,
            typeof params.detail === 'string' ? params.detail : undefined,
          );
        }
        return;
      }
      case 'log': {
        const level =
          params.level === 'warn' || params.level === 'error' || params.level === 'debug'
            ? params.level
            : 'info';
        const message = typeof params.msg === 'string' ? params.msg : '';
        this.deps.log[level](`[${this.id} ${replica.id}] ${redactText(message)}`, {
          core: this.id,
          replica: replica.id,
        });
        return;
      }
      default:
        this.deps.log.warn('external core sent an unknown notification', { core: this.id, method });
    }
  }

  private onEvent(replica: Replica, params: Record<string, unknown>): void {
    const { kind, summary } = params;
    if (
      typeof kind !== 'string' ||
      !kind.startsWith(`${this.id}.`) ||
      typeof summary !== 'string'
    ) {
      this.deps.log.warn(
        'external core event dropped (kind must start with the core id, summary required)',
        {
          core: this.id,
          replica: replica.id,
          kind: typeof kind === 'string' ? kind : null,
        },
      );
      return;
    }
    const level = LEVELS.includes(params.level as EventLevel)
      ? (params.level as EventLevel)
      : 'info';
    if (level === 'debug' && this.coreConfig?.eventLevel !== 'debug') return;
    const actor = ACTORS.includes(params.actor as Actor) ? (params.actor as Actor) : 'product';
    this.deps.bus.emit({
      core: this.id,
      replica: replica.id,
      kind,
      level,
      actor,
      summary: summary.slice(0, 200),
      payload: params.payload ?? {},
      ...(typeof params.correlationId === 'string' ? { correlationId: params.correlationId } : {}),
      ...(typeof params.latencyMs === 'number' ? { latencyMs: params.latencyMs } : {}),
    });
  }

  private setReplicaState(replica: Replica, to: CoreState, detail?: string): void {
    const from = replica.state;
    const sameDetail = (to === 'error' ? detail : undefined) === replica.detail;
    if (from === to && sameDetail) return;
    replica.state = to;
    if (to === 'error') replica.detail = detail;
    else delete replica.detail;
    this.deps.bus.emit({
      core: 'testbed',
      replica: replica.id,
      kind: 'testbed.core.state',
      level: to === 'error' ? 'error' : 'info',
      actor: 'system',
      summary: `core ${this.id} ${replica.id}: ${from} → ${to}${to === 'error' && detail !== undefined ? ` (${detail})` : ''}`,
      payload: {
        core: this.id,
        replica: replica.id,
        from,
        to,
        ...(to === 'error' && detail !== undefined ? { detail } : {}),
      },
    });
    this.updateOverall();
  }

  private updateOverall(): void {
    const states = this.replicas.map((replica) => replica.state);
    const next = PRECEDENCE.find((state) => states.includes(state)) ?? 'idle';
    if (next === this.overall) return;
    const from = this.overall;
    this.overall = next;
    const detail = this.state().detail;
    this.deps.bus.emit({
      core: 'testbed',
      kind: 'testbed.core.state',
      level: next === 'error' ? 'error' : 'info',
      actor: 'system',
      summary: `core ${this.id}: ${from} → ${next}${detail === undefined ? '' : ` (${detail})`}`,
      payload: { core: this.id, from, to: next, ...(detail === undefined ? {} : { detail }) },
    });
  }
}
