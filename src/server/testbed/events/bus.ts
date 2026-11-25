/**
 * The in-process event bus (docs/testbed/events.md §1–§4).
 *
 * `emit` fills in the envelope's common fields (seq, id, ts, runId), keeps
 * only the first 4 characters of a caller's ids, masks secrets, caps the
 * payload size, keeps the event in the ring buffer and
 * hands it to every subscriber (Run store, WS broadcaster, waiters).
 */
import {
  matchesFilter,
  type Actor,
  type Caller,
  type EventFilter,
  type EventLevel,
  type TestbedEvent,
} from '@shared/testbed/events';
import { nowUtc } from '@shared/time';

import { publicCaller } from '../control/caller';
import { DEFAULT_MAX_PAYLOAD_BYTES, limitPayload } from '../payload-limit';
import { redact } from '../redact';
import { cursorSeq, queryLimit } from './filter';
import { RingBuffer } from './ring-buffer';

const DEFAULT_EVENT_BUFFER = 5000;

/** What an emitter supplies; the bus fills in the rest. */
export interface EventInput<P = unknown> {
  core: string;
  kind: string;
  level?: EventLevel;
  actor: Actor;
  /** The control-service caller behind it; recorded as `publicCaller` (4-character ids). */
  caller?: Caller;
  summary: string;
  payload?: P;
  replica?: string;
  correlationId?: string;
  latencyMs?: number;
  /** Keys to mask beyond the common ones (docs/testbed/events.md §4). */
  redactKeys?: readonly string[];
}

export type EventSubscriber = (event: TestbedEvent) => void;

export interface EventBusOptions {
  /** A fresh one per boot; tests pass a fixed one. */
  instanceId?: string;
  bufferSize?: number;
  maxPayloadBytes?: number;
}

export class EventBus {
  readonly instanceId: string;
  private readonly buffer: RingBuffer<TestbedEvent>;
  private readonly maxPayloadBytes: number;
  private readonly subscribers = new Set<EventSubscriber>();
  private nextSeq = 0;
  /** Set by the Run manager while a Run is open. */
  currentRunId: string | null = null;

  constructor(options: EventBusOptions = {}) {
    this.instanceId = options.instanceId ?? crypto.randomUUID().slice(0, 8);
    this.buffer = new RingBuffer(options.bufferSize ?? DEFAULT_EVENT_BUFFER);
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  }

  emit<P>(input: EventInput<P>): TestbedEvent {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const { payload, truncated } = limitPayload(
      redact(input.payload ?? {}, input.redactKeys),
      this.maxPayloadBytes,
    );
    const event: TestbedEvent = {
      seq,
      id: `${this.instanceId}:${seq}`,
      ts: nowUtc(),
      runId: this.currentRunId,
      core: input.core,
      ...(input.replica === undefined ? {} : { replica: input.replica }),
      kind: input.kind,
      level: input.level ?? 'info',
      actor: input.actor,
      ...(input.caller === undefined ? {} : { caller: publicCaller(input.caller) }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
      summary: input.summary,
      payload,
      ...(truncated ? { truncated: true } : {}),
    };
    this.buffer.push(event);
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }

  /** Returns the unsubscribe function. */
  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Everything still in the ring buffer, oldest first. */
  buffered(): TestbedEvent[] {
    return this.buffer.toArray();
  }

  /**
   * Ring-buffer query: the first `limit` events after the cursor that match.
   * `runId` narrows to one Run (`'current'` = the open one). A cursor from
   * another boot throws `CURSOR_STALE`.
   */
  query(filter: EventFilter): TestbedEvent[] {
    return this.page(filter).events;
  }

  /** {@link query}, plus how many events match in all (past `limit` too). */
  page(filter: EventFilter): { events: TestbedEvent[]; total: number } {
    const afterSeq = filter.after === undefined ? -1 : cursorSeq(filter.after, this.instanceId);
    const runId = filter.runId === 'current' ? this.currentRunId : filter.runId;
    if (filter.runId !== undefined && runId === null) return { events: [], total: 0 };
    const events: TestbedEvent[] = [];
    const limit = queryLimit(filter);
    let total = 0;
    for (const event of this.buffer.toArray()) {
      if (event.seq <= afterSeq) continue;
      if (filter.runId !== undefined && event.runId !== runId) continue;
      if (!matchesFilter(event, filter)) continue;
      total += 1;
      if (events.length < limit) events.push(event);
    }
    return { events, total };
  }
}
