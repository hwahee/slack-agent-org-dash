/**
 * The stdio transport to an external core process
 * (docs/testbed/external-core-protocol.md §3, §7).
 *
 * JSON-RPC 2.0 over NDJSON: one message per line, at most 1 MiB. Requests
 * go glue → core only; the core sends notifications back. stdout carries the
 * protocol alone — a line that is not JSON-RPC, or is over the limit, is
 * dropped and reported. stderr is passed on line by line.
 */

/** Longest stdout line read as a message. */
const MAX_LINE_BYTES = 1024 * 1024;

export interface RpcHandlers {
  /** A notification from the core (`event`, `fault`, `state`, `log`). */
  notification(method: string, params: unknown): void;
  stderr(line: string): void;
  /** A stdout line that was not a message (not JSON-RPC, or over 1 MiB). */
  dropped(reason: string, preview: string): void;
  /** The process ended (whoever asked for it). */
  exit(code: number | null, signal: string | null): void;
}

/** The core answered with a JSON-RPC error. */
export class RpcRequestError extends Error {
  override readonly name = 'RpcRequestError';
  constructor(
    readonly method: string,
    readonly rpcCode: number,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
  }
}

/** No answer within the time allowed. */
export class RpcTimeoutError extends Error {
  override readonly name = 'RpcTimeoutError';
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method}: no answer within ${timeoutMs}ms`);
  }
}

/** The process ended before it answered. */
export class RpcClosedError extends Error {
  override readonly name = 'RpcClosedError';
  constructor(readonly method: string) {
    super(`${method}: the core process ended before answering`);
  }
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const NEWLINE = 0x0a;

/** Splits a byte stream into lines, giving up on (and reporting) lines over the limit. */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  onTooLong: (preview: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let parts: Uint8Array[] = [];
  let length = 0;
  let skipping = false;
  for await (const chunk of stream) {
    let start = 0;
    for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, start)) {
      const piece = chunk.subarray(start, index);
      start = index + 1;
      if (skipping) {
        skipping = false;
        continue;
      }
      if (length + piece.byteLength > MAX_LINE_BYTES) {
        onTooLong(decoder.decode(parts[0]?.subarray(0, 80) ?? piece.subarray(0, 80)));
      } else {
        parts.push(piece);
        onLine(decoder.decode(Buffer.concat(parts)));
      }
      parts = [];
      length = 0;
    }
    const rest = chunk.subarray(start);
    if (skipping || rest.byteLength === 0) continue;
    if (length + rest.byteLength > MAX_LINE_BYTES) {
      onTooLong(decoder.decode((parts[0] ?? rest).subarray(0, 80)));
      parts = [];
      length = 0;
      skipping = true;
      continue;
    }
    // Copy: the stream may reuse the chunk's memory.
    parts.push(rest.slice());
    length += rest.byteLength;
  }
}

export class StdioRpc {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  readonly done: Promise<void>;

  private constructor(
    private readonly process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>,
    private readonly handlers: RpcHandlers,
  ) {
    const stdout = readLines(
      process.stdout,
      (line) => this.onLine(line),
      (preview) => handlers.dropped(`line over ${MAX_LINE_BYTES} bytes`, preview),
    );
    const stderr = readLines(
      process.stderr,
      (line) => handlers.stderr(line),
      (preview) => handlers.stderr(`${preview}… (line over ${MAX_LINE_BYTES} bytes)`),
    );
    this.done = (async () => {
      await process.exited;
      await Promise.allSettled([stdout, stderr]);
      this.close();
      handlers.exit(process.exitCode, process.signalCode);
    })();
  }

  /** Starts the process. Throws (e.g. `code: 'ENOENT'`) when it cannot. */
  static spawn(
    command: readonly string[],
    options: { cwd: string; env: Record<string, string>; handlers: RpcHandlers },
  ): StdioRpc {
    const process = Bun.spawn([...command], {
      cwd: options.cwd,
      env: options.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return new StdioRpc(process, options.handlers);
  }

  get pid(): number {
    return this.process.pid;
  }

  get exited(): boolean {
    return this.closed;
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcClosedError(method));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
        // A pipe the process has closed fails here or later; either way the
        // request ends by its timeout or by the process's exit.
        void Promise.resolve(this.process.stdin.write(line)).catch(() => undefined);
        void Promise.resolve(this.process.stdin.flush()).catch(() => undefined);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RpcClosedError(method));
      }
    });
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!this.closed) this.process.kill(signal);
  }

  /** Whether the process ended within `ms`. */
  async waitExit(ms: number): Promise<boolean> {
    if (this.closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const ended = await Promise.race([this.done.then(() => true as const), timeout]);
    clearTimeout(timer);
    return ended;
  }

  private onLine(line: string): void {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.handlers.dropped('not JSON', line.slice(0, 80));
      return;
    }
    if (
      typeof message !== 'object' ||
      message === null ||
      (message as { jsonrpc?: unknown }).jsonrpc !== '2.0'
    ) {
      this.handlers.dropped('not JSON-RPC 2.0', line.slice(0, 80));
      return;
    }
    const { id, method, params, result, error } = message as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown; data?: unknown };
    };
    if (typeof method === 'string' && id === undefined) {
      this.handlers.notification(method, params);
      return;
    }
    if (typeof id !== 'number') {
      this.handlers.dropped('neither a response nor a notification', line.slice(0, 80));
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return; // Answered after its timeout.
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error !== undefined) {
      pending.reject(
        new RpcRequestError(
          pending.method,
          typeof error.code === 'number' ? error.code : -32_603,
          typeof error.message === 'string' ? error.message : 'error',
          error.data,
        ),
      );
    } else {
      pending.resolve(result);
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new RpcClosedError(pending.method));
    }
  }
}
