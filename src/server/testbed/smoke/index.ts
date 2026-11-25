/**
 * MCP smoke scenarios (docs/testbed/verification.md §2): what a scenario file
 * imports. A scenario lives in `src/server/testbed/cores/<core>/smoke/*.smoke.ts`
 * (an example core's in `examples/<example>/smoke/*.smoke.ts`) and default-exports `defineSmoke({...})`; `bun run testbed:smoke` finds and
 * runs it against a live instance over MCP, REST and the data plane.
 */
import type { EventFilter } from '@shared/testbed/events';

/** What the smoke reads from `GET /testbed/api/manifest`. */
export interface SmokeManifest {
  name: string;
  version: string;
  instanceId: string;
  cores: {
    id: string;
    state: string;
    /** The configured replica count (1 for in-proc cores). */
    replicas: number;
    endpoints: { name: string; protocol: string; url: string; replica?: string }[];
    actions: { name: string; mutating: boolean; surfaces: string[] }[];
  }[];
  auth: { control: 'none' | 'bearer' };
}

/** One MCP session — one agent. */
export interface SmokeSession {
  /** Calls a tool; its `structuredContent`. An `isError` result fails the scenario. */
  call<T = Record<string, unknown>>(tool: string, input?: Record<string, unknown>): Promise<T>;
  /** A call that must fail with `code`; the error. Success or another code fails the scenario. */
  callError(
    tool: string,
    input: Record<string, unknown>,
    code: string,
  ): Promise<{ code: string; message: string; details?: unknown }>;
}

/** A TCP connection to a data-plane endpoint. */
export interface SmokeTcp {
  send(data: string | Uint8Array): void;
  /** The next `bytes` bytes as UTF-8 (default timeout 5 s). */
  receive(bytes: number, timeoutMs?: number): Promise<string>;
  /** The next `bytes` bytes as they are. */
  receiveBytes(bytes: number, timeoutMs?: number): Promise<Uint8Array>;
  /** Resolves once the other side closed the connection; fails after `timeoutMs` (default 5 s). */
  closed(timeoutMs?: number): Promise<void>;
  close(): void;
}

export interface SmokeContext extends SmokeSession {
  /** Another MCP session (another agent). Closed with the scenario. */
  newSession(name?: string): Promise<SmokeSession>;
  /**
   * A REST call under `/testbed/api` as a person (no `actor`) or as `agent`/`ci`
   * (the control token is sent when the smoke has one).
   */
  rest<T = Record<string, unknown>>(
    method: string,
    path: string,
    options?: { body?: unknown; actor?: 'agent' | 'ci'; lease?: string },
  ): Promise<{ status: number; body: T }>;
  readonly manifest: SmokeManifest;
  /** A data-plane address, e.g. `tcp://localhost:40001`. */
  endpoint(core: string, name: string): string;
  tcp(url: string): Promise<SmokeTcp>;
  /** `check`; fails (with the matching event lines) unless it passes. */
  expectCheck(filter: EventFilter, expect: { count?: string; none?: true }): Promise<void>;
  /** `wait_for`; fails if it timed out. */
  waitFor(
    filter: EventFilter,
    count?: number,
    timeoutMs?: number,
  ): Promise<{ matched: number; events: { id: string; kind: string; summary: string }[] }>;
  /** Deep equality. */
  equal(actual: unknown, expected: unknown, message?: string): void;
  ok(condition: unknown, message?: string): void;
}

export interface SmokeDefinition {
  /** Unique across scenarios; used in the report and `--only`. */
  name: string;
  title: string;
  /** The acceptance criterion it is based on, e.g. `docs/spec.md §11 M3`. */
  spec: string;
  /** Skipped (not failed) when the manifest lacks one of these cores. */
  requires?: { cores?: string[] };
  /** Default 60 000. */
  timeoutMs?: number;
  run(t: SmokeContext): Promise<void>;
}

export function defineSmoke(definition: SmokeDefinition): SmokeDefinition {
  return definition;
}
