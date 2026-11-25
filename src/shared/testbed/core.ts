/**
 * What a core reports about itself (docs/testbed/core-contract.md §3) —
 * shared because the manifest and the dashboard show it.
 */
export type CoreKind = 'passive' | 'active' | 'scenario';

export type CoreState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

/** A data-plane address the product connects to. */
export interface CoreEndpoint {
  name: string;
  protocol: string;
  url: string;
  /** The external core replica it belongs to (`r0`, `r1`, …). */
  replica?: string;
}

/** One process of an external core (docs/testbed/external-core-protocol.md §6, §8). */
export interface ReplicaStatus {
  id: string;
  state: CoreState;
  detail?: string;
  pid?: number;
  /** Restarts since it last ran stably. */
  restarts: number;
  /** How long the last `status` ping took. */
  lastPingMs?: number;
  counters: Record<string, number>;
  endpoints: CoreEndpoint[];
}

/** The fault kinds a core can apply (docs/testbed/faults-and-seed.md §1). */
export type FaultKind = 'delay' | 'error' | 'disconnect' | 'corrupt';

export interface CoreStatus {
  id: string;
  kind: CoreKind;
  title: string;
  state: CoreState;
  /** Why the core is in `error` (e.g. `EADDRINUSE`). */
  detail?: string;
  endpoints: CoreEndpoint[];
  counters: Record<string, number>;
  /** An external core (a process of its own). */
  external?: true;
  /** An external core's replicas; `state`, `counters` and `endpoints` above sum them up. */
  replicas?: ReplicaStatus[];
}
