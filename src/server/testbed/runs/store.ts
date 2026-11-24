/**
 * Run persistence contract (`TESTBED_RUN_STORE`, docs/testbed/events.md §1).
 *
 * Only events with a `runId` reach a store. Both drivers keep the latest
 * `retention` closed Runs and delete the one closed longest ago beyond that.
 */
import type { TestbedEvent } from '@shared/testbed/events';
import type { RunMeta } from '@shared/testbed/runs';

export const DEFAULT_RUN_RETENTION = 50;

export interface RunStore {
  /** Writes a new Run's meta. */
  create(meta: RunMeta): Promise<void>;
  /** Appends one event to its Run. May be batched; `events()` and `close()` see it. */
  append(event: TestbedEvent): void;
  /** Writes the closed Run's final meta, then applies retention. */
  close(meta: RunMeta): Promise<void>;
  get(runId: string): Promise<RunMeta | null>;
  /** Newest first. */
  list(): Promise<RunMeta[]>;
  /** The Run's events in order (empty for an unknown Run). */
  events(runId: string): Promise<TestbedEvent[]>;
  /** Where the Run's JSONL lives on disk (`file` driver), or `undefined`. */
  location(runId: string): string | undefined;
}

/** The ids of closed Runs to delete so only `retention` remain. */
export function runsOverRetention(metas: readonly RunMeta[], retention: number): string[] {
  const closed = metas
    .filter((meta) => meta.endedAt !== undefined)
    .sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''));
  return closed.slice(0, Math.max(0, closed.length - retention)).map((meta) => meta.runId);
}

/** Newest first, by start time. */
export function newestFirst(metas: RunMeta[]): RunMeta[] {
  return metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
