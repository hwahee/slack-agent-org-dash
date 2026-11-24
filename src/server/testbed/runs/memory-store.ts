/**
 * `TESTBED_RUN_STORE=memory` (the default): gone on restart.
 */
import type { TestbedEvent } from '@shared/testbed/events';
import type { RunMeta } from '@shared/testbed/runs';

import { DEFAULT_RUN_RETENTION, newestFirst, runsOverRetention, type RunStore } from './store';

export function createMemoryRunStore(retention = DEFAULT_RUN_RETENTION): RunStore {
  const runs = new Map<string, { meta: RunMeta; events: TestbedEvent[] }>();

  return {
    create(meta) {
      runs.set(meta.runId, { meta: structuredClone(meta), events: [] });
      return Promise.resolve();
    },
    append(event) {
      if (event.runId !== null) runs.get(event.runId)?.events.push(event);
    },
    close(meta) {
      const stored = runs.get(meta.runId);
      if (stored) stored.meta = structuredClone(meta);
      const metas = [...runs.values()].map((run) => run.meta);
      for (const runId of runsOverRetention(metas, retention)) runs.delete(runId);
      return Promise.resolve();
    },
    get(runId) {
      const stored = runs.get(runId);
      return Promise.resolve(stored ? structuredClone(stored.meta) : null);
    },
    list() {
      return Promise.resolve(
        newestFirst([...runs.values()].map((run) => structuredClone(run.meta))),
      );
    },
    events(runId) {
      return Promise.resolve([...(runs.get(runId)?.events ?? [])]);
    },
  };
}
