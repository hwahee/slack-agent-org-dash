/**
 * WS adapter — `/testbed/ws`, for the dashboard (docs/testbed/control-plane.md §5).
 *
 * On connect: `snapshot` (status + the latest events). Then increments:
 * `event` (batched every 100 ms), `status` (a core changed state, a Run
 * opened or closed) and `lease`. Nothing is operated over WS.
 *
 * Back-pressure (docs/testbed/events.md §1): above 200 events in a second the
 * stream is sampled — one in ten goes out — and each `event` batch says how
 * many were left out. The ring buffer and Run store keep everything.
 */
import type { TestbedSocketMessage } from '@shared/testbed/control';
import type { TestbedEvent } from '@shared/testbed/events';

import type { ControlService } from '../control/service';
import type { EventBus } from '../events/bus';

interface Socket {
  send(data: string): unknown;
}

const SNAPSHOT_EVENTS = 200;
const FLUSH_MS = 100;
const SAMPLE_ABOVE_PER_SECOND = 200;
const SAMPLE_ONE_IN = 10;

const STATUS_KINDS = new Set(['testbed.core.state', 'testbed.run.started', 'testbed.run.ended']);

export class TestbedSocketHub {
  private readonly sockets = new Set<Socket>();
  private queue: TestbedEvent[] = [];
  private omitted = 0;
  private windowStart = 0;
  private inWindow = 0;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly control: ControlService,
    private readonly bus: EventBus,
  ) {
    this.unsubscribe = bus.subscribe((event) => this.onEvent(event));
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  open(socket: Socket): void {
    this.flush(); // so the snapshot and the increments after it never overlap
    this.sockets.add(socket);
    this.sendTo(socket, {
      type: 'snapshot',
      status: this.control.status(),
      events: this.bus.buffered().slice(-SNAPSHOT_EVENTS),
    });
  }

  close(socket: Socket): void {
    this.sockets.delete(socket);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.unsubscribe();
  }

  private onEvent(event: TestbedEvent): void {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.inWindow = 0;
    }
    this.inWindow += 1;
    const over = this.inWindow - SAMPLE_ABOVE_PER_SECOND;
    if (over > 0 && over % SAMPLE_ONE_IN !== 0) this.omitted += 1;
    else this.queue.push(event);

    // State changes go out right away, after the events that led to them.
    if (STATUS_KINDS.has(event.kind)) {
      this.flush();
      this.broadcast({ type: 'status', status: this.control.status() });
    } else if (event.kind.startsWith('testbed.lease.')) {
      this.flush();
      this.broadcast({ type: 'lease', lease: this.control.lease.view() });
    }
  }

  private flush(): void {
    if (this.queue.length === 0 && this.omitted === 0) return;
    const message: TestbedSocketMessage = {
      type: 'event',
      events: this.queue,
      omitted: this.omitted,
    };
    this.queue = [];
    this.omitted = 0;
    this.broadcast(message);
  }

  private broadcast(message: TestbedSocketMessage): void {
    if (this.sockets.size === 0) return;
    const data = JSON.stringify(message);
    for (const socket of this.sockets) socket.send(data);
  }

  private sendTo(socket: Socket, message: TestbedSocketMessage): void {
    socket.send(JSON.stringify(message));
  }
}
