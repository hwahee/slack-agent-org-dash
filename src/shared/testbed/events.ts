/**
 * The common event envelope and the filter every event query shares
 * (docs/testbed/events.md §2, docs/testbed/control-plane.md §1.2).
 *
 * Shared because the dashboard reads the same envelopes over WS.
 */
import type { UtcIsoString } from '@shared/time';
import { s, toValidator } from '@shared/validation';

const EVENT_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export type Actor = 'product' | 'human' | 'agent' | 'ci' | 'system';

/** Who called a control-service function (docs/testbed/control-plane.md §1.1). */
export interface Caller {
  actor: Actor;
  /** MCP session id (`Mcp-Session-Id`). */
  sessionId?: string;
  /** Lease id taken over REST. */
  leaseId?: string;
  /** Display name, e.g. MCP `clientInfo.name`. */
  name?: string;
}

export interface TestbedEvent<P = unknown> {
  /** Monotonic within one boot; starts at 0 every boot. */
  seq: number;
  /** `${instanceId}:${seq}` — doubles as the cursor. */
  id: string;
  ts: UtcIsoString;
  /** `null` outside a Run. */
  runId: string | null;
  /** Core id; the common runtime itself is `testbed`. */
  core: string;
  replica?: string;
  /** `<core>.<target>.<verb>`, verb in the past tense. */
  kind: string;
  level: EventLevel;
  actor: Actor;
  correlationId?: string;
  latencyMs?: number;
  /** One line, at most 200 characters. Required. */
  summary: string;
  payload: P;
  /** The payload was over the size cap; see `limitPayload`. */
  truncated?: boolean;
}

/**
 * One event without its payload — what agents get in lists
 * (docs/testbed/control-plane.md §4).
 */
export interface EventLine {
  id: string;
  ts: UtcIsoString;
  level: EventLevel;
  kind: string;
  summary: string;
  correlationId?: string;
}

export function toEventLine(event: TestbedEvent): EventLine {
  const { id, ts, level, kind, summary, correlationId } = event;
  return {
    id,
    ts,
    level,
    kind,
    summary,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export interface EventFilter {
  /** A Run id, or `'current'` for the open Run. */
  runId?: string;
  core?: string;
  /** Kind prefix: `llm.completion` matches everything under it. */
  kind?: string;
  /** This level or above. */
  level?: EventLevel;
  actor?: Actor;
  correlationId?: string;
  /** Substring of `summary`. */
  text?: string;
  /** Cursor `<instanceId>:<seq>`: only events after it. */
  after?: string;
  /** Default 50, at most 500. */
  limit?: number;
}

/** The filter's schema, for inputs that embed it (MCP `wait_for`, `check`). */
export const eventFilterSchema = s.object({
  runId: s.optional(s.string().check(s.minLength(1))),
  core: s.optional(s.string().check(s.minLength(1))),
  kind: s.optional(s.string().check(s.minLength(1))),
  level: s.optional(s.enum(EVENT_LEVELS)),
  actor: s.optional(s.enum(['product', 'human', 'agent', 'ci', 'system'])),
  correlationId: s.optional(s.string().check(s.minLength(1))),
  text: s.optional(s.string().check(s.minLength(1))),
  after: s.optional(s.string().check(s.minLength(1))),
  limit: s.optional(s.int().check(s.gte(1), s.lte(500))),
});

/** Validates a filter from a request (JSON body, or query string values coerced by the caller). */
export const eventFilterValidator = toValidator(eventFilterSchema);

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
