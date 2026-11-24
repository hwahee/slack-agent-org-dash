/**
 * docs/spec.md §11 M9 performance: 2000 events a second for 10 seconds into
 * the store (no DOM). Subscribers hear at most 10 times a second, and working
 * out the visible log rows takes at most 5 ms each time.
 */
import { describe, expect, test } from 'bun:test';

import type { TestbedEvent } from '@shared/testbed/events';
import type { UtcIsoString } from '@shared/time';

import { TestbedStore, type Clock, type SocketHandlers } from '../store/store';
import { selectLogEvents } from './log-filter';
import { visibleRange } from './virtual';

class FakeClock implements Clock {
  private time = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  now = () => this.time;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };
  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.time = next.at;
      next.fn();
    }
    this.time = until;
  }
}

const KINDS = ['sample.data.received', 'sample.data.echoed', 'sample.connection.opened'];

describe('dashboard under 2000 events per second', () => {
  test('≤ 10 notifications a second, visible rows in ≤ 5 ms', () => {
    const clock = new FakeClock();
    let socket: SocketHandlers | undefined;
    const store = new TestbedStore({
      clock,
      connect: (handlers) => {
        socket = handlers;
        return { close: () => undefined };
      },
    });
    const notifications: number[] = [];
    const rowTimes: number[] = [];
    store.subscribe(() => {
      notifications.push(clock.now());
      // What the event log does on each snapshot: filter, then the rows in view.
      const started = performance.now();
      const { events, status } = store.getSnapshot();
      const rows = selectLogEvents(
        events,
        { run: 'current', kind: 'sample.data', text: 'c-' },
        status?.run?.runId ?? null,
      );
      const range = visibleRange({
        scrollTop: Math.max(0, rows.length * 28 - 560),
        viewportHeight: 560,
        rowHeight: 28,
        count: rows.length,
      });
      rows.slice(range.start, range.end);
      rowTimes.push(performance.now() - started);
    });
    store.start();
    socket?.message(
      JSON.stringify({
        type: 'snapshot',
        status: { instanceId: 'boot', cores: [], run: null, lease: null },
        events: [],
      }),
    );

    // The server batches every 100 ms: 200 events per batch is 2000 a second.
    let seq = 0;
    for (let tick = 0; tick < 100; tick++) {
      const events: TestbedEvent[] = Array.from({ length: 200 }, () => {
        const n = seq++;
        return {
          seq: n,
          id: `boot:${n}`,
          ts: new Date(clock.now()).toISOString() as UtcIsoString,
          runId: null,
          core: 'sample',
          kind: KINDS[n % KINDS.length] ?? 'sample.data.echoed',
          level: 'info',
          actor: 'product',
          summary: `c-${n % 50} echoed 32B in 1ms`,
          payload: { connId: `c-${n % 50}`, bytes: 32 },
        };
      });
      socket?.message(JSON.stringify({ type: 'event', events, omitted: 0 }));
      clock.advance(100);
    }
    clock.advance(100);

    expect(store.getSnapshot().events).toHaveLength(5000);
    for (let second = 0; second < 10; second++) {
      const inSecond = notifications.filter(
        (at) => at >= second * 1000 && at < (second + 1) * 1000,
      );
      expect(inSecond.length).toBeLessThanOrEqual(10);
    }
    expect(notifications.length).toBeGreaterThanOrEqual(90);
    expect(Math.max(...rowTimes)).toBeLessThanOrEqual(5);
  });
});
