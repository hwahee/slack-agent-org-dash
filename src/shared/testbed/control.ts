/**
 * What the control plane answers with, as the dashboard reads it
 * (docs/testbed/control-plane.md §3, §5, §6).
 */
import type { CoreEndpoint, CoreKind, CoreState, CoreStatus, FaultKind } from './core';
import type { TestbedEvent } from './events';
import type { LeaseView } from './lease';
import type { RunMeta } from './runs';

/** `GET /status`, and the WS `snapshot`/`status` messages. */
export interface TestbedStatus {
  instanceId: string;
  cores: CoreStatus[];
  run: RunMeta | null;
  lease: LeaseView | null;
}

/** `GET /manifest` (§6). */
export interface TestbedManifest {
  name: string;
  version: string;
  instanceId: string;
  baseVersion: string;
  /** `TESTBED_PUBLIC_URL`: every address handed out is built on it. */
  publicUrl: string;
  cores: {
    id: string;
    kind: CoreKind;
    title: string;
    state: CoreState;
    /** A process of its own (docs/testbed/external-core-protocol.md). */
    external: boolean;
    /** The configured replica count (1 for in-proc cores). */
    replicas: number;
    endpoints: CoreEndpoint[];
    actions: {
      name: string;
      title: string;
      description: string;
      mutating: boolean;
      surfaces: ('rest' | 'mcp' | 'ui')[];
      inputSchema: Record<string, unknown>;
    }[];
    configSchema: Record<string, unknown>;
    faults: readonly FaultKind[];
  }[];
  control: { rest: string; mcp: string; ws: string };
  auth: { control: 'none' | 'bearer' };
  features: { runStore: 'memory' | 'file'; seed: boolean };
}

/** `getCoreLog` / `GET /cores/:core/log` (§2, §3): each replica's latest stderr lines, masked. */
export interface CoreLog {
  core: string;
  external: boolean;
  replicas: { replica: string; lines: string[] }[];
  /** Why there is nothing to show (an in-proc core has no process). */
  note?: string;
}

/** `/testbed/ws` messages (§5). */
export type TestbedSocketMessage =
  | { type: 'snapshot'; status: TestbedStatus; events: TestbedEvent[] }
  | { type: 'event'; events: TestbedEvent[]; omitted: number }
  | { type: 'status'; status: TestbedStatus }
  | { type: 'lease'; lease: LeaseView | null };
