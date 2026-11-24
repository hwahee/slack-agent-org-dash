/**
 * The in-proc core host (docs/testbed/core-contract.md §1–§4).
 *
 * Registers cores, holds their config (env defaults → validated), drives the
 * state machine and announces every change as `testbed.core.state`, wires
 * each core's context (emit, rng, faults, signal) and runs actions. Leases
 * and `testbed.control.invoked` are the control service's job, on top.
 */
import type { CoreState, CoreStatus, FaultKind } from '@shared/testbed/core';
import type { Caller } from '@shared/testbed/events';
import type { FaultRule } from '@shared/testbed/faults';
import { ValidationError, type ValidationIssue } from '@shared/validation';

import type { Logger } from '../lib/log';
import { NotFoundError } from '../lib/errors';
import type { BaseCoreConfig, CoreContext, CoreDefinition, CoreInstance } from './core';
import { TestbedError } from './errors';
import type { EventBus } from './events/bus';
import { FaultDecider } from './faults';
import type { RunManager } from './runs/runs';

const CORE_ID = /^[a-z][a-z0-9-]*$/;

export interface CoreHostOptions {
  bus: EventBus;
  runs: RunManager;
  log: Logger;
  /** Where `defaultConfig` reads `<CORE_ID>_*` from. */
  env?: Record<string, string | undefined>;
  bindHost?: string;
  publicHost?: string;
}

interface HostedCore {
  definition: CoreDefinition;
  instance: CoreInstance;
  config: BaseCoreConfig;
  faults: FaultDecider;
  state: CoreState;
  detail?: string;
  abort: AbortController;
}

/** The fault kinds a rule uses. */
function kindsOf(rule: FaultRule): FaultKind[] {
  const kinds: FaultKind[] = [];
  if (rule.delayMs !== undefined) kinds.push('delay');
  if (rule.error !== undefined) kinds.push('error');
  if (rule.disconnect) kinds.push('disconnect');
  if (rule.corrupt) kinds.push('corrupt');
  return kinds;
}

function unsupportedFaults(
  rules: readonly FaultRule[],
  supported: readonly FaultKind[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  rules.forEach((rule, index) => {
    for (const kind of kindsOf(rule)) {
      if (!supported.includes(kind)) {
        issues.push({
          path: `faults.${index}`,
          message: `fault '${kind}' is not supported by this core (supported: ${supported.join(', ') || 'none'})`,
          code: 'unsupported_fault',
        });
      }
    }
  });
  return issues;
}

function errorDetail(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

export class CoreHost {
  private readonly cores = new Map<string, HostedCore>();
  private readonly env: Record<string, string | undefined>;
  private readonly bindHost: string;
  private readonly publicHost: string;

  constructor(private readonly options: CoreHostOptions) {
    this.env = options.env ?? {};
    this.bindHost = options.bindHost ?? '127.0.0.1';
    this.publicHost = options.publicHost ?? 'localhost';
  }

  /** Validates the definition and its env defaults; the core starts `idle`. */
  register(definition: CoreDefinition): void {
    const { id } = definition;
    if (!CORE_ID.test(id) || id === 'testbed') {
      throw new Error(`invalid core id '${id}': ^[a-z][a-z0-9-]*$, and not 'testbed'`);
    }
    if (this.cores.has(id)) throw new Error(`core '${id}' is already registered`);

    const config = this.validate(definition, definition.defaultConfig(this.env));
    const { bus, runs, log } = this.options;
    const faults = new FaultDecider(
      () => runs.rng(),
      (decision, selector, correlationId) => {
        const { ruleId, ...effects } = decision;
        bus.emit({
          core: 'testbed',
          kind: 'testbed.fault.injected',
          level: 'warn',
          actor: 'system',
          ...(correlationId === undefined ? {} : { correlationId }),
          summary: `fault ${ruleId} on ${id}: ${Object.keys(effects).join('+') || 'none'}`,
          payload: { core: id, ruleId, effects, selector },
        });
      },
    );
    faults.setRules(config.faults);

    // The context reads `hosted` lazily, so the instance can be created from it.
    const hosted: Omit<HostedCore, 'instance'> & { instance?: CoreInstance } = {
      definition,
      config,
      faults,
      state: 'idle',
      abort: new AbortController(),
    };
    const ctx: CoreContext<BaseCoreConfig> = {
      emit: (event) => {
        if (!event.kind.startsWith(`${id}.`)) {
          throw new Error(`core '${id}' may only emit '${id}.*' kinds, got '${event.kind}'`);
        }
        if (event.level === 'debug' && hosted.config.eventLevel !== 'debug') return;
        bus.emit({ ...event, core: id, actor: event.actor ?? 'product' });
      },
      log,
      get rng() {
        return runs.rng();
      },
      run: () => runs.active(),
      faults,
      get signal() {
        return hosted.abort.signal;
      },
      config: () => hosted.config,
      bindHost: this.bindHost,
      publicHost: this.publicHost,
    };
    hosted.instance = definition.create(ctx);
    this.cores.set(id, hosted as HostedCore);
  }

  /** Starts every core whose config says `autoStart`. */
  async startAutoStart(): Promise<void> {
    for (const [id, core] of this.cores) {
      if (core.config.autoStart) await this.start(id);
    }
  }

  async start(id: string): Promise<CoreStatus> {
    const core = this.get(id);
    if (core.state === 'running' || core.state === 'starting') return this.status(id);
    core.abort = new AbortController();
    this.transition(id, core, 'starting');
    try {
      await core.instance.start();
      this.transition(id, core, 'running');
    } catch (error) {
      this.transition(id, core, 'error', errorDetail(error));
    }
    return this.status(id);
  }

  async stop(id: string): Promise<CoreStatus> {
    const core = this.get(id);
    if (core.state !== 'running') return this.status(id);
    this.transition(id, core, 'stopping');
    core.abort.abort();
    try {
      await core.instance.stop();
      this.transition(id, core, 'stopped');
    } catch (error) {
      this.transition(id, core, 'error', errorDetail(error));
    }
    return this.status(id);
  }

  /** Stops every running core — graceful shutdown. */
  async stopAll(): Promise<void> {
    for (const id of this.cores.keys()) await this.stop(id);
  }

  /** Clears the core's state and counters and starts its fault `times` over. */
  async reset(id: string): Promise<CoreStatus> {
    const core = this.get(id);
    await core.instance.reset?.();
    core.faults.reset();
    return this.status(id);
  }

  getConfig(id: string): BaseCoreConfig {
    return structuredClone(this.get(id).config);
  }

  /**
   * Partial patch. Invalid → `ValidationError` and nothing changes. The new
   * config is stored either way; `restart-required` means it applies on the
   * next stop → start.
   */
  async setConfig(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<'applied' | 'restart-required'> {
    const core = this.get(id);
    const next = this.validate(core.definition, { ...core.config, ...patch });
    core.config = next;
    core.faults.setRules(next.faults);
    return core.state === 'running' ? core.instance.applyConfig(next) : 'applied';
  }

  status(id: string): CoreStatus {
    const core = this.get(id);
    const { kind, title } = core.definition;
    return {
      id,
      kind,
      title,
      state: core.state,
      ...(core.detail === undefined ? {} : { detail: core.detail }),
      ...core.instance.status(),
    };
  }

  statusAll(): CoreStatus[] {
    return [...this.cores.keys()].map((id) => this.status(id));
  }

  /** Validates the input, runs the action, validates the output. */
  async invokeAction(id: string, name: string, input: unknown, caller: Caller): Promise<unknown> {
    const core = this.get(id);
    const action = core.definition.actions?.[name];
    if (!action) throw new NotFoundError('action', `${id}.${name}`);
    const parsed = action.input.parse(input);
    if (core.state !== 'running') {
      throw new TestbedError(
        'CORE_NOT_RUNNING',
        `코어 ${id}가 running이 아님(${core.state}). start 후 다시 시도`,
        {
          core: id,
          state: core.state,
        },
      );
    }
    return action.output.parse(await action.run(core.instance, parsed, caller));
  }

  private get(id: string): HostedCore {
    const core = this.cores.get(id);
    if (!core) throw new NotFoundError('core', id);
    return core;
  }

  private validate(definition: CoreDefinition, raw: unknown): BaseCoreConfig {
    const config = definition.configSchema.parse(raw);
    const issues = unsupportedFaults(config.faults, definition.faults ?? []);
    if (issues.length > 0) throw new ValidationError(issues);
    return config;
  }

  private transition(id: string, core: HostedCore, to: CoreState, detail?: string): void {
    const from = core.state;
    core.state = to;
    if (to === 'error') core.detail = detail;
    else delete core.detail;
    this.options.bus.emit({
      core: 'testbed',
      kind: 'testbed.core.state',
      level: to === 'error' ? 'error' : 'info',
      actor: 'system',
      summary: `core ${id}: ${from} → ${to}${detail === undefined ? '' : ` (${detail})`}`,
      payload: { core: id, from, to, ...(detail === undefined ? {} : { detail }) },
    });
  }
}
