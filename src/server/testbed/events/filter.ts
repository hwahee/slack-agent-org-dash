/**
 * The event filter shared by `queryEvents`, `waitFor` and `check`
 * (docs/testbed/control-plane.md §1.2) and the cursor format
 * (docs/testbed/events.md §3).
 */
import { EVENT_LEVELS, type EventFilter, type TestbedEvent } from '@shared/testbed/events';

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

/**
 * Whether `event` passes every field of `filter` except `runId`, `after` and
 * `limit`, which choose *where* to look rather than *what* matches.
 */
export function matchesFilter(event: TestbedEvent, filter: EventFilter): boolean {
  if (filter.core !== undefined && event.core !== filter.core) return false;
  if (
    filter.kind !== undefined &&
    event.kind !== filter.kind &&
    !event.kind.startsWith(`${filter.kind}.`)
  ) {
    return false;
  }
  if (
    filter.level !== undefined &&
    EVENT_LEVELS.indexOf(event.level) < EVENT_LEVELS.indexOf(filter.level)
  ) {
    return false;
  }
  if (filter.actor !== undefined && event.actor !== filter.actor) return false;
  if (filter.correlationId !== undefined && event.correlationId !== filter.correlationId) {
    return false;
  }
  if (filter.text !== undefined && !event.summary.includes(filter.text)) return false;
  return true;
}
