/**
 * The dashboard store against a fake WS and a fake clock (docs/spec.md §11 M7).
 */
import { describe, expect, test } from 'bun:test';

import type { TestbedSocketMessage, TestbedStatus } from '@shared/testbed/control';
import type { TestbedEvent } from '@shared/testbed/events';
import type { UtcIsoString } from '@shared/time';

import { TestbedStore, type Clock, type SocketHandlers } from './store';

/** Timers that run only when the test moves time forward. */
class FakeClock implements Clock {
  private time = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const next = this.timers
        .filter((timer) => timer.at <= until)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.time = next.at;
      next.fn();
    }
    this.time = until;
  }
}

class FakeServer {
  connections: SocketHandlers[] = [];
  connect = (handlers: SocketHandlers) => {
    this.connections.push(handlers);
    return { close: () => undefined };
  };

  get current(): SocketHandlers {
    const handlers = this.connections.at(-1);
    if (!handlers) throw new Error('not connected');
    return handlers;
  }

  send(message: TestbedSocketMessage): void {
    this.current.message(JSON.stringify(message));
  }
}

function status(instanceId: string): TestbedStatus {
  return { instanceId, cores: [], run: null, lease: null };
}

let seq = 0;
function event(instanceId = 'boot1'): TestbedEvent {
  const n = seq++;
  return {
    seq: n,
    id: `${instanceId}:${n}`,
    ts: '2026-11-24T00:00:00.000Z' as UtcIsoString,
    runId: null,
    core: 'sample',
    kind: 'sample.data.echoed',
    level: 'info',
    actor: 'product',
    summary: `event ${n}`,
    payload: {},
  };
}

function setup(options: { maxEvents?: number; probe?: number } = {}) {
  const clock = new FakeClock();
  const server = new FakeServer();
  const store = new TestbedStore({
    connect: server.connect,
    clock,
    probe: () => Promise.resolve(options.probe ?? 0),
    ...(options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents }),
  });
  let notified = 0;
  const notifyTimes: number[] = [];
  store.subscribe(() => {
    notified += 1;
    notifyTimes.push(clock.now());
  });
  store.start();
  return { clock, server, store, notifyTimes, notified: () => notified };
}

describe('TestbedStore', () => {
  test('snapshot, then event increments pile up in order', () => {
    const { clock, server, store } = setup();
    const first = [event(), event()];
    server.send({ type: 'snapshot', status: status('boot1'), events: first });
    const more = [event(), event(), event()];
    server.send({ type: 'event', events: more.slice(0, 2), omitted: 0 });
    server.send({ type: 'event', events: more.slice(2), omitted: 4 });
    clock.advance(100);

    const snapshot = store.getSnapshot();
    expect(snapshot.connection).toBe('open');
    expect(snapshot.status?.instanceId).toBe('boot1');
    expect(snapshot.events.map((e) => e.id)).toEqual([...first, ...more].map((e) => e.id));
    expect(snapshot.omitted).toBe(4);
  });

  test('over the cap the oldest events go first', () => {
    const { clock, server, store } = setup({ maxEvents: 5 });
    const all = Array.from({ length: 7 }, () => event());
    server.send({ type: 'snapshot', status: status('boot1'), events: all.slice(0, 3) });
    server.send({ type: 'event', events: all.slice(3), omitted: 0 });
    clock.advance(100);
    expect(store.getSnapshot().events.map((e) => e.id)).toEqual(all.slice(2).map((e) => e.id));
  });

  test('the default cap is 5000', () => {
    const { clock, server, store } = setup();
    server.send({ type: 'snapshot', status: status('boot1'), events: [] });
    const burst = Array.from({ length: 5003 }, () => event());
    server.send({ type: 'event', events: burst, omitted: 0 });
    clock.advance(100);
    const { events } = store.getSnapshot();
    expect(events).toHaveLength(5000);
    expect(events[0]?.id).toBe(burst[3]?.id);
  });

  test('status and lease messages update the snapshot; the lease time is stamped', () => {
    const { clock, server, store } = setup();
    server.send({ type: 'snapshot', status: status('boot1'), events: [] });
    clock.advance(500);
    const lease = {
      actor: 'agent' as const,
      name: 'claude',
      holder: 'ab12',
      expiresAt: '2026-11-24T00:10:00.000Z' as UtcIsoString,
      remainingMs: 600_000,
    };
    server.send({ type: 'lease', lease });
    clock.advance(100);
    expect(store.getSnapshot().lease).toEqual(lease);
    expect(store.getSnapshot().status?.lease).toEqual(lease);
    expect(store.getSnapshot().leaseReceivedAt).toBe(500);

    server.send({ type: 'status', status: { ...status('boot1'), lease: null } });
    clock.advance(100);
    expect(store.getSnapshot().lease).toBeNull();
  });

  test('a dropped connection retries after 1 s, doubling to 10 s; the new snapshot replaces everything', async () => {
    const { clock, server, store } = setup();
    server.send({ type: 'snapshot', status: status('boot1'), events: [event(), event()] });
    server.send({ type: 'event', events: [event()], omitted: 3 });
    server.current.close();
    clock.advance(100);
    expect(store.getSnapshot().connection).toBe('reconnecting');

    // 1 s after a connection that worked (100 ms of it already passed).
    clock.advance(899);
    expect(server.connections).toHaveLength(1);
    clock.advance(1);
    expect(server.connections).toHaveLength(2);

    // Attempts that fail before any message: 2 s, 4 s, 8 s, then 10 s, 10 s.
    const waits: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = server.connections.length;
      server.current.close();
      await Promise.resolve(); // the probe
      await Promise.resolve();
      let waited = 0;
      while (server.connections.length === before) {
        clock.advance(1000);
        waited += 1000;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([2000, 4000, 8000, 10_000, 10_000]);

    const fresh = [event()];
    server.send({ type: 'snapshot', status: status('boot1'), events: fresh });
    clock.advance(100);
    const snapshot = store.getSnapshot();
    expect(snapshot.connection).toBe('open');
    expect(snapshot.events.map((e) => e.id)).toEqual(fresh.map((e) => e.id));
    expect(snapshot.omitted).toBe(0);
    expect(snapshot.restarted).toBe(false);
  });

  test('a different instanceId after reconnecting raises the restart notice once', () => {
    const { clock, server, store } = setup();
    server.send({ type: 'snapshot', status: status('boot1'), events: [] });
    server.current.close();
    clock.advance(1000);
    server.send({ type: 'snapshot', status: status('boot2'), events: [event('boot2')] });
    clock.advance(100);
    expect(store.getSnapshot().restarted).toBe(true);
    expect(store.getSnapshot().status?.instanceId).toBe('boot2');

    store.dismissRestart();
    clock.advance(100);
    expect(store.getSnapshot().restarted).toBe(false);

    // Reconnecting to the same instance says nothing.
    server.current.close();
    clock.advance(1000);
    server.send({ type: 'snapshot', status: status('boot2'), events: [] });
    clock.advance(100);
    expect(store.getSnapshot().restarted).toBe(false);
  });

  test('subscribers hear at most once per 100 ms, however many messages arrive', () => {
    const { clock, server, notifyTimes } = setup();
    server.send({ type: 'snapshot', status: status('boot1'), events: [] });
    for (let ms = 0; ms < 1000; ms += 5) {
      server.send({ type: 'event', events: [event(), event()], omitted: 0 });
      clock.advance(5);
    }
    clock.advance(100);
    expect(notifyTimes.length).toBeGreaterThan(0);
    expect(notifyTimes.length).toBeLessThanOrEqual(11);
    for (let i = 1; i < notifyTimes.length; i++) {
      expect((notifyTimes[i] ?? 0) - (notifyTimes[i - 1] ?? 0)).toBeGreaterThanOrEqual(100);
    }
  });

  test('the snapshot keeps its identity until something is published', () => {
    const { clock, server, store } = setup();
    server.send({ type: 'snapshot', status: status('boot1'), events: [] });
    clock.advance(100);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    server.send({ type: 'event', events: [event()], omitted: 0 });
    expect(store.getSnapshot()).toBe(first);
    clock.advance(100);
    expect(store.getSnapshot()).not.toBe(first);
  });

  test('closed before any message and the status probe says 401: sign-in needed, no retry', async () => {
    const { clock, server, store } = setup({ probe: 401 });
    server.current.close();
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(100);
    expect(store.getSnapshot().connection).toBe('unauthorized');
    clock.advance(60_000);
    expect(server.connections).toHaveLength(1);
  });

  test('stop closes the connection and nothing reconnects', () => {
    const { clock, server, store } = setup();
    server.send({ type: 'snapshot', status: status('boot1'), events: [] });
    store.stop();
    server.connections[0]?.close();
    clock.advance(60_000);
    expect(server.connections).toHaveLength(1);
  });
});
