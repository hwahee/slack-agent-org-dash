/**
 * Test helpers for the common runtime: wait on events instead of sleeping
 * (docs/testbed/verification.md §3), and a small TCP client.
 */
import type { TestbedEvent } from '@shared/testbed/events';

import type { EventBus } from './events/bus';

/** Resolves with the first event (already buffered or still to come) that matches. */
export function waitForEvent(
  bus: EventBus,
  predicate: (event: TestbedEvent) => boolean,
  timeoutMs = 3000,
): Promise<TestbedEvent> {
  const seen = bus.buffered().find(predicate);
  if (seen) return Promise.resolve(seen);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no matching event within ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = bus.subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

/** A TCP client that collects what it receives and notices when it is closed. */
export class TcpClient {
  private received: Uint8Array[] = [];
  private waiters: (() => void)[] = [];
  readonly closed: Promise<void>;
  private markClosed!: () => void;

  private constructor(private socket: Bun.Socket<undefined>) {
    this.closed = new Promise((resolve) => {
      this.markClosed = resolve;
    });
  }

  static async connect(url: string): Promise<TcpClient> {
    const { hostname, port } = new URL(url.replace(/^tcp:/, 'http:'));
    // The handlers run only after connect resolves, once `holder.client` is set.
    const holder: { client?: TcpClient } = {};
    const socket = await Bun.connect({
      hostname,
      port: Number(port),
      socket: {
        data: (_socket, chunk) => holder.client?.onData(chunk),
        close: () => holder.client?.markClosed(),
        end: () => holder.client?.markClosed(),
      },
    });
    holder.client = new TcpClient(socket);
    return holder.client;
  }

  private onData(chunk: Buffer): void {
    this.received.push(new Uint8Array(chunk));
    for (const wake of this.waiters.splice(0)) wake();
  }

  send(data: Uint8Array | string): void {
    this.socket.write(data);
  }

  bytes(): Uint8Array {
    return Buffer.concat(this.received);
  }

  /** Resolves once at least `n` bytes have arrived. */
  async receive(n: number, timeoutMs = 3000): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (this.bytes().byteLength < n) {
      if (Date.now() > deadline)
        throw new Error(`received ${this.bytes().byteLength}B, wanted ${n}B`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return this.bytes();
  }

  close(): void {
    this.socket.end();
  }
}
