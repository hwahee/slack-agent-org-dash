/**
 * How events read on the dashboard: local time, redacted values and the
 * caller behind an operation.
 */
import type { TestbedEvent } from '@shared/testbed/events';

/** `HH:MM:SS.mmm` in the browser's time zone. */
export function localTime(ts: string): string {
  const date = new Date(ts);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** The common masking format: `sk-a…(len 51, sha256:3f9a0c1d22be)` (docs/testbed/events.md §4). */
const REDACTED = /…\(len \d+, sha256:[0-9a-f]{12}\)$/;

export function isRedacted(value: unknown): boolean {
  return typeof value === 'string' && REDACTED.test(value);
}

/** The agent timeline: agent events, every control call and every lease change. */
export function isAgentTimelineEvent(event: TestbedEvent): boolean {
  return (
    event.actor === 'agent' ||
    event.kind.startsWith('testbed.control.') ||
    event.kind.startsWith('testbed.lease.')
  );
}

interface CallerLike {
  actor?: string;
  name?: string;
  sessionId?: string;
  leaseId?: string;
  holder?: string;
}

/**
 * Who did it, as `name · ab12`: the caller of a control call or a refused
 * one, or the lease holder of a lease event. Ids are 4 characters already.
 */
export function callerLabel(event: TestbedEvent): string {
  const payload = (event.payload ?? {}) as { caller?: CallerLike; lease?: CallerLike | null };
  const who = payload.caller ?? payload.lease ?? undefined;
  if (!who) return event.actor;
  const name = who.name ?? who.actor ?? event.actor;
  const id = (who.sessionId ?? who.leaseId ?? who.holder ?? '').slice(0, 4);
  return id === '' ? name : `${name} · ${id}`;
}
