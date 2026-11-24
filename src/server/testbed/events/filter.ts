/**
 * The event filter shared by `queryEvents`, `waitFor` and `check`
 * (docs/testbed/control-plane.md §1.2) and the cursor format
 * (docs/testbed/events.md §3).
 */
import type { EventFilter } from '@shared/testbed/events';

import { TestbedError } from '../errors';

const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 500;

/** `limit` clamped to 1..500, default 50. */
export function queryLimit(filter: EventFilter): number {
  const limit = filter.limit ?? DEFAULT_QUERY_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_QUERY_LIMIT);
}

/**
 * The `seq` after which to read, or throws `CURSOR_STALE` when the cursor is
 * from another boot.
 */
export function cursorSeq(cursor: string, instanceId: string): number {
  const separator = cursor.lastIndexOf(':');
  const cursorInstance = separator === -1 ? '' : cursor.slice(0, separator);
  const seq = Number(cursor.slice(separator + 1));
  if (cursorInstance !== instanceId || !Number.isInteger(seq) || seq < 0) {
    const fresh = `${instanceId}:0`;
    throw new TestbedError(
      'CURSOR_STALE',
      `테스트베드가 재시작됨. 새 커서 ${fresh}부터 다시 조회`,
      { cursor: fresh },
    );
  }
  return seq;
}
