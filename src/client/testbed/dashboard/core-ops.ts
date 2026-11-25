/**
 * Which core-card operations would do anything in the core's current state
 * (docs/testbed/dashboard.md §1.2). The host ignores `start` on a running or
 * starting core and `stop` on one that is not running; the card disables those
 * buttons instead of letting a click pass silently. An external core is judged
 * by its replicas: `start` while one is down, `stop` while one is running.
 * `reset` works in every state.
 */
import type { CoreState, CoreStatus } from '@shared/testbed/core';

const STARTABLE: readonly CoreState[] = ['idle', 'stopped', 'error'];

export function applicableOps(
  state: CoreState,
  status: CoreStatus | undefined,
): { start: boolean; stop: boolean; reset: boolean } {
  const replicas = status?.replicas ?? [];
  const states = replicas.length > 0 ? replicas.map((replica) => replica.state) : [state];
  return {
    start: states.some((each) => STARTABLE.includes(each)),
    stop: states.includes('running'),
    reset: true,
  };
}
