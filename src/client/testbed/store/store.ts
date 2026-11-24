/**
 * The dashboard's live state, kept outside React (docs/testbed/dashboard.md §3).
 *
 * It follows `/testbed/ws`: a `snapshot` fills it, then `event`, `status` and
 * `lease` messages update it. Only the latest 5000 events are kept; the
 * `omitted` counts of sampled `event` batches add up. A dropped connection is
 * retried after 1 s, doubling up to 10 s; the next `snapshot` replaces
 * everything, and a different `instanceId` raises a one-time "restarted"
 * notice. Subscribers hear about changes at most every 100 ms (≤ 10 Hz), so a
 * burst of thousands of events costs a handful of renders.
 */
import type { TestbedSocketMessage, TestbedStatus } from '@shared/testbed/control';
import type { TestbedEvent } from '@shared/testbed/events';
import type { LeaseView } from '@shared/testbed/lease';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'unauthorized';

export interface TestbedSnapshot {
  connection: ConnectionState;
  /** `null` until the first `snapshot`. */
  status: TestbedStatus | null;
  /** Oldest first, at most `maxEvents`. */
  events: readonly TestbedEvent[];
  /** Events the server left out of `event` batches (sampling), added up. */
  omitted: number;
  lease: LeaseView | null;
  /** Local `Date.now()` when `lease` arrived — its `remainingMs` counts from then. */
  leaseReceivedAt: number;
  /** The instance changed since the last connection; cleared by `dismissRestart`. */
  restarted: boolean;
}

/** What a connection reports (a WebSocket, or a fake one in tests). */
export interface SocketHandlers {
  message(data: string): void;
  close(): void;
}

/** An open connection: only closing it is needed. */
export interface SocketLike {
  close(): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TestbedStoreOptions {
  /** Opens the socket (default: `new WebSocket(<same origin>/testbed/ws)`). */
  connect?: (handlers: SocketHandlers) => SocketLike;
  /**
   * Called when a connection closes before anything arrived: the HTTP status of
   * `GET /testbed/api/status`, so a 401 (sign-in required) stops the retries.
   */
  probe?: () => Promise<number>;
  clock?: Clock;
  maxEvents?: number;
}

const MAX_EVENTS = 5000;
const NOTIFY_EVERY_MS = 100;
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 10_000;

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function defaultConnect(handlers: SocketHandlers): SocketLike {
  const url = new URL('/testbed/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') handlers.message(event.data);
  });
  socket.addEventListener('close', () => handlers.close());
  return socket;
}

async function defaultProbe(): Promise<number> {
  const response = await fetch('/testbed/api/status', { headers: { accept: 'application/json' } });
  return response.status;
}

export class TestbedStore {
  private snapshot: TestbedSnapshot;
  /** What has changed but not been published yet. */
  private draft: TestbedSnapshot;
  private events: TestbedEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private socket: SocketLike | null = null;
  private stopped = true;
  private retryMs = RETRY_FIRST_MS;
  private retryTimer: unknown;
  private notifyTimer: unknown;
  private lastNotify = -Infinity;
  /** The instance of the last snapshot, across reconnects. */
  private instanceId: string | null = null;
  private readonly clock: Clock;
  private readonly maxEvents: number;

  constructor(private readonly options: TestbedStoreOptions = {}) {
    this.clock = options.clock ?? realClock;
    this.maxEvents = options.maxEvents ?? MAX_EVENTS;
    this.snapshot = {
      connection: 'connecting',
      status: null,
      events: [],
      omitted: 0,
      lease: null,
      leaseReceivedAt: 0,
      restarted: false,
    };
    this.draft = this.snapshot;
  }

  // ── useSyncExternalStore ──────────────────────────────────────────────────

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): TestbedSnapshot => this.snapshot;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clock.clearTimeout(this.retryTimer);
    this.clock.clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  dismissRestart(): void {
    this.update({ restarted: false });
  }

  // ── Socket ────────────────────────────────────────────────────────────────

  private open(): void {
    let heard = false;
    const socket: SocketLike = (this.options.connect ?? defaultConnect)({
      message: (data) => {
        if (this.socket !== socket) return;
        heard = true;
        this.receive(JSON.parse(data) as TestbedSocketMessage);
      },
      close: () => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.stopped) return;
        if (heard) {
          this.retryMs = RETRY_FIRST_MS;
          this.update({ connection: 'reconnecting' });
          this.retry();
          return;
        }
        void this.probeThenRetry();
      },
    });
    this.socket = socket;
  }

  private async probeThenRetry(): Promise<void> {
    const status = await (this.options.probe ?? defaultProbe)().catch(() => 0);
    if (this.stopped) return;
    if (status === 401) {
      this.update({ connection: 'unauthorized' });
      return;
    }
    this.update({ connection: 'reconnecting' });
    this.retry();
  }

  private retry(): void {
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retryTimer = this.clock.setTimeout(() => {
      if (!this.stopped) this.open();
    }, delay);
  }

  private receive(message: TestbedSocketMessage): void {
    switch (message.type) {
      case 'snapshot': {
        const restarted = this.instanceId !== null && this.instanceId !== message.status.instanceId;
        this.instanceId = message.status.instanceId;
        this.retryMs = RETRY_FIRST_MS;
        this.events = message.events.slice(-this.maxEvents);
        this.update({
          connection: 'open',
          status: message.status,
          events: this.events,
          omitted: 0,
          lease: message.status.lease,
          leaseReceivedAt: this.clock.now(),
          restarted: restarted || this.draft.restarted,
        });
        return;
      }
      case 'event': {
        this.events.push(...message.events);
        if (this.events.length > this.maxEvents) {
          this.events = this.events.slice(-this.maxEvents);
        }
        this.update({ events: this.events, omitted: this.draft.omitted + message.omitted });
        return;
      }
      case 'status':
        this.update({
          status: message.status,
          lease: message.status.lease,
          leaseReceivedAt: this.clock.now(),
        });
        return;
      case 'lease':
        this.update({
          lease: message.lease,
          leaseReceivedAt: this.clock.now(),
          ...(this.draft.status ? { status: { ...this.draft.status, lease: message.lease } } : {}),
        });
        return;
    }
  }

  // ── Publishing ────────────────────────────────────────────────────────────

  private update(change: Partial<TestbedSnapshot>): void {
    this.draft = { ...this.draft, ...change };
    if (this.notifyTimer !== undefined) return;
    const wait = Math.max(0, this.lastNotify + NOTIFY_EVERY_MS - this.clock.now());
    this.notifyTimer = this.clock.setTimeout(() => this.publish(), wait);
  }

  private publish(): void {
    this.notifyTimer = undefined;
    this.lastNotify = this.clock.now();
    // A fresh array, so `events` changes identity exactly when it is published.
    this.snapshot = { ...this.draft, events: [...this.draft.events] };
    for (const listener of this.listeners) listener();
  }
}
