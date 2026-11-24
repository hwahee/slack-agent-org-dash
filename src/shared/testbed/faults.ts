/**
 * The common fault-injection rule (docs/testbed/faults-and-seed.md §1).
 */
export interface FaultRule {
  id: string;
  /** Core-specific selector; every key must equal the request's. Absent = every request. */
  match?: Record<string, unknown>;
  /** 0..1, default 1. */
  probability?: number;
  delayMs?: number | { min: number; max: number };
  /** An error kind the core declared (e.g. `http-500`). */
  error?: string;
  disconnect?: boolean;
  corrupt?: boolean;
  /** Inactive after applying this many times. */
  times?: number;
}
