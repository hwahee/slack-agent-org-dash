/**
 * Run metadata and summary (docs/testbed/runs-and-checks.md §1).
 */
import type { UtcIsoString } from '@shared/time';

import type { Caller, EventLevel } from './events';

export type RunEndReason = 'ended' | 'replaced' | 'restart';

export interface CheckOutcome {
  label?: string;
  pass: boolean;
  matched: number;
}

export interface RunSummary {
  durationMs: number;
  /** Events per kind. */
  byKind: Record<string, number>;
  /** Events per level. */
  byLevel: Record<EventLevel, number>;
  /** The kinds with the most `error` events (top 5), with one summary each. */
  topErrors: { kind: string; count: number; summary: string }[];
  /** Every check evaluated while the Run was open, in order. */
  checks: CheckOutcome[];
}

export interface RunMeta {
  runId: string;
  label: string;
  /** The boot this Run was opened in. */
  instanceId: string;
  seed: string;
  /** Every core's config when the Run started (overrides applied). */
  configSnapshot: Record<string, unknown>;
  openedBy: Caller;
  endedBy?: Caller;
  endReason?: RunEndReason;
  startedAt: UtcIsoString;
  endedAt?: UtcIsoString;
  summary?: RunSummary;
}
