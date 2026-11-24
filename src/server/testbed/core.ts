/**
 * The in-proc core contract (docs/testbed/core-contract.md §1).
 *
 * A core is a `CoreDefinition`; the core host turns it into a running
 * `CoreInstance` and hands it a `CoreContext`. Every core config carries the
 * common fields in `BaseCoreConfig`.
 */
import type { CoreEndpoint, CoreKind, FaultKind } from '@shared/testbed/core';
import type { Caller } from '@shared/testbed/events';
import type { FaultRule } from '@shared/testbed/faults';
import type { RunMeta } from '@shared/testbed/runs';
import type { Validator } from '@shared/validation';

import type { Logger } from '../lib/log';
import type { EventInput } from './events/bus';
import type { FaultDecider } from './faults';
import type { SeededRng } from './rng';

/** The config fields the host itself reads. */
export interface BaseCoreConfig {
  /** Start at boot. passive cores default to `true`, active and scenario to `false`. */
  autoStart: boolean;
  /** `info` drops the core's `debug` events (docs/testbed/events.md §1). */
  eventLevel: 'debug' | 'info';
  faults: FaultRule[];
}

/**
 * What a core emits: the envelope fields the host fills in are left out.
 * @public part of the core contract
 */
export type CoreEventInput = Omit<EventInput, 'core' | 'actor'> & {
  /** Default `product` — most core events are data-plane traffic. */
  actor?: EventInput['actor'];
};

export interface CoreContext<C extends BaseCoreConfig> {
  /** Fills in core, actor and the rest of the envelope; `kind` must start with `<core id>.`. */
  emit(event: CoreEventInput): void;
  log: Logger;
  /** Every random number comes from here (the open Run's seed, else the boot seed). */
  readonly rng: SeededRng;
  /** The open Run, or `null`. */
  run(): RunMeta | null;
  faults: FaultDecider;
  /** Aborted when the core stops or the process shuts down. */
  readonly signal: AbortSignal;
  /** The current config — read it where it is used, so runtime changes take effect. */
  config(): C;
  /** Data-plane bind address (`TESTBED_BIND_HOST`). */
  bindHost: string;
  /** Host name for endpoint URLs (from `TESTBED_PUBLIC_URL`). */
  publicHost: string;
}

export interface CoreInstance {
  /** Throwing puts the core in `error`; an error's `code` (e.g. `EADDRINUSE`) becomes the detail. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Clears internal state and counters; listeners stay. */
  reset?(): Promise<void>;
  /**
   * Called with the next config while running; it is already stored. Return
   * `restart-required` when it only takes effect on the next start.
   */
  applyConfig(next: unknown): Promise<'applied' | 'restart-required'>;
  status(): { endpoints: CoreEndpoint[]; counters: Record<string, number> };
}

/** @public part of the core contract (`CoreDefinition.actions`) */
export interface ActionDefinition<I extends CoreInstance = CoreInstance> {
  title: string;
  /** For agents: side effects, units, limits, whether the lease is needed. */
  description: string;
  input: Validator<unknown>;
  output: Validator<unknown>;
  /** `true` needs the control lease. */
  mutating: boolean;
  surfaces?: ('rest' | 'mcp' | 'ui')[];
  /** Runs only while the core is `running`. */
  run(instance: I, input: unknown, caller: Caller): Promise<unknown>;
}

export interface CoreDefinition<
  C extends BaseCoreConfig = BaseCoreConfig,
  I extends CoreInstance = CoreInstance,
> {
  /** `^[a-z][a-z0-9-]*$`, not `testbed`. */
  id: string;
  kind: CoreKind;
  title: string;
  configSchema: Validator<C>;
  /** Boot defaults from env (`<CORE_ID>_*`); never read `process.env` elsewhere. */
  defaultConfig(env: Record<string, string | undefined>): unknown;
  actions?: Record<string, ActionDefinition<I>>;
  /** The fault kinds this core applies; rules using others fail validation. */
  faults?: readonly FaultKind[];
  create(ctx: CoreContext<C>): I;
}
