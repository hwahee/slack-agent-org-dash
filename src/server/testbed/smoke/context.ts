/**
 * The `t` a scenario gets: MCP sessions, REST, TCP and assertions, all
 * recording which step is running so a failure says where it happened.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { EventFilter } from '@shared/testbed/events';

import type { SmokeContext, SmokeManifest, SmokeSession, SmokeTcp } from './index';

/** Where the smoke points: the instance's base URL and the control token, if any. */
export interface SmokeTarget {
  url: string;
  token?: string;
}

/** A scenario failed at `step`. */
export class SmokeFailure extends Error {
  override readonly name = 'SmokeFailure';
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_IO_TIMEOUT_MS = 5000;
/** MCP requests may wait (`wait_for` up to 120 s); the SDK's default is 60 s. */
const MCP_REQUEST_TIMEOUT_MS = 130_000;

interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function short(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** What one scenario has going: its step, the tools it called, what to clean up. */
export class ScenarioState {
  step = 'start';
  readonly called = new Set<string>();
  readonly sessions: McpSession[] = [];
  readonly sockets: TcpConnection[] = [];

  constructor(
    readonly target: SmokeTarget,
    readonly name: string,
  ) {}

  /** Runs `fn` as the named step; a non-`SmokeFailure` error becomes one. */
  async at<T>(step: string, fn: () => Promise<T>): Promise<T> {
    this.step = step;
    try {
      return await fn();
    } catch (error) {
      if (error instanceof SmokeFailure) throw error;
      throw new SmokeFailure(step, error instanceof Error ? error.message : String(error));
    }
  }

  fail(message: string): never {
    throw new SmokeFailure(this.step, message);
  }
}

export class McpSession implements SmokeSession {
  private constructor(
    private readonly state: ScenarioState,
    private readonly client: Client,
    private readonly transport: StreamableHTTPClientTransport,
  ) {}

  static async open(state: ScenarioState, clientName: string): Promise<McpSession> {
    const { url, token } = state.target;
    const transport = new StreamableHTTPClientTransport(
      new URL('/testbed/mcp', url),
      token === undefined
        ? undefined
        : { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );
    const client = new Client({ name: clientName, version: '0.0.0' });
    await client.connect(transport);
    const session = new McpSession(state, client, transport);
    state.sessions.push(session);
    return session;
  }

  /** The raw result, for cleanup (no step, no failure). */
  async tool(name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await this.client.callTool({ name, arguments: input }, undefined, {
      timeout: MCP_REQUEST_TIMEOUT_MS,
    })) as ToolResult;
  }

  call<T = Record<string, unknown>>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    return this.state.at(`call ${tool}`, async () => {
      this.state.called.add(tool);
      const result = await this.tool(tool, input);
      if (result.isError) {
        const error = (result.structuredContent?.error ?? {}) as { code?: string };
        this.state.fail(
          `${tool} failed: ${error.code ?? 'error'} — ${result.content?.[0]?.text ?? ''}`,
        );
      }
      return (result.structuredContent ?? {}) as T;
    });
  }

  callError(tool: string, input: Record<string, unknown>, code: string) {
    return this.state.at(`callError ${tool}`, async () => {
      this.state.called.add(tool);
      const result = await this.tool(tool, input);
      if (!result.isError) {
        this.state.fail(`${tool} succeeded, expected ${code}: ${short(result.structuredContent)}`);
      }
      const error = (result.structuredContent?.error ?? {}) as {
        code: string;
        message: string;
        details?: unknown;
      };
      if (error.code !== code) {
        this.state.fail(`${tool} failed with ${error.code}, expected ${code}: ${error.message}`);
      }
      return error;
    });
  }

  /** Ends the session (`DELETE`), which also drops a lease it holds. */
  async close(): Promise<void> {
    try {
      await this.transport.terminateSession();
    } catch {
      // Already gone (idle close, server stopped).
    }
    await this.client.close();
  }
}

class TcpConnection implements SmokeTcp {
  private buffer = new Uint8Array(0);
  private ended = false;
  private wake: (() => void)[] = [];

  private constructor(private socket: Bun.Socket<undefined>) {}

  static async connect(url: string): Promise<TcpConnection> {
    const { hostname, port } = new URL(url.replace(/^tcp:/, 'http:'));
    const holder: { conn?: TcpConnection } = {};
    const socket = await Bun.connect({
      hostname,
      port: Number(port),
      socket: {
        data: (_socket, chunk) => holder.conn?.onData(chunk),
        close: () => holder.conn?.onEnd(),
        end: () => holder.conn?.onEnd(),
        error: () => holder.conn?.onEnd(),
      },
    });
    holder.conn = new TcpConnection(socket);
    return holder.conn;
  }

  private notify(): void {
    for (const wake of this.wake.splice(0)) wake();
  }

  private onData(chunk: Buffer): void {
    const next = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    next.set(this.buffer);
    next.set(chunk, this.buffer.byteLength);
    this.buffer = next;
    this.notify();
  }

  private onEnd(): void {
    this.ended = true;
    this.notify();
  }

  /** Waits until `done()` holds; false if the time ran out. */
  private async until(done: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        this.wake.push(resolve);
        setTimeout(resolve, Math.min(left, 100));
      });
    }
    return true;
  }

  send(data: string | Uint8Array): void {
    this.socket.write(data);
  }

  async receiveBytes(bytes: number, timeoutMs = DEFAULT_IO_TIMEOUT_MS): Promise<Uint8Array> {
    const enough = await this.until(() => this.buffer.byteLength >= bytes || this.ended, timeoutMs);
    if (!enough || this.buffer.byteLength < bytes) {
      throw new Error(
        `received ${this.buffer.byteLength}B, wanted ${bytes}B${this.ended ? ' (connection closed)' : ` within ${timeoutMs}ms`}`,
      );
    }
    const out = this.buffer.slice(0, bytes);
    this.buffer = this.buffer.slice(bytes);
    return out;
  }

  async receive(bytes: number, timeoutMs?: number): Promise<string> {
    return new TextDecoder().decode(await this.receiveBytes(bytes, timeoutMs));
  }

  async closed(timeoutMs = DEFAULT_IO_TIMEOUT_MS): Promise<void> {
    if (!(await this.until(() => this.ended, timeoutMs))) {
      throw new Error(`connection still open after ${timeoutMs}ms`);
    }
  }

  close(): void {
    this.socket.end();
  }
}

/** A REST call under `/testbed/api`. */
export async function restCall<T>(
  target: SmokeTarget,
  method: string,
  path: string,
  options: { body?: unknown; actor?: 'agent' | 'ci'; lease?: string } = {},
): Promise<{ status: number; body: T }> {
  const machine = options.actor !== undefined;
  const response = await fetch(new URL(`/testbed/api${path}`, target.url), {
    method,
    headers: {
      ...(machine ? { 'x-testbed-actor': options.actor } : {}),
      ...(machine && target.token !== undefined ? { authorization: `Bearer ${target.token}` } : {}),
      ...(options.lease === undefined ? {} : { 'x-testbed-lease': options.lease }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, body: body as T };
}

export async function createContext(
  state: ScenarioState,
  manifest: SmokeManifest,
): Promise<SmokeContext> {
  const main = await McpSession.open(state, `smoke:${state.name}`);
  let extra = 0;
  return {
    call: (tool, input) => main.call(tool, input),
    callError: (tool, input, code) => main.callError(tool, input, code),
    newSession: (name) =>
      state.at('newSession', () =>
        McpSession.open(state, name ?? `smoke:${state.name}:${++extra}`),
      ),
    rest: (method, path, options) =>
      state.at(`rest ${method} ${path}`, () => restCall(state.target, method, path, options)),
    manifest,
    endpoint(core, name) {
      const url = manifest.cores
        .find((entry) => entry.id === core)
        ?.endpoints.find((endpoint) => endpoint.name === name)?.url;
      if (url === undefined) state.fail(`no endpoint ${core}/${name} in the manifest`);
      return url;
    },
    tcp: (url) =>
      state.at(`tcp connect ${url}`, async () => {
        const conn = await TcpConnection.connect(url);
        state.sockets.push(conn);
        return {
          send: (data) => conn.send(data),
          receive: (bytes, timeoutMs) =>
            state.at(`tcp receive ${bytes}B`, () => conn.receive(bytes, timeoutMs)),
          receiveBytes: (bytes, timeoutMs) =>
            state.at(`tcp receive ${bytes}B`, () => conn.receiveBytes(bytes, timeoutMs)),
          closed: (timeoutMs) => state.at('tcp closed', () => conn.closed(timeoutMs)),
          close: () => conn.close(),
        };
      }),
    async expectCheck(filter: EventFilter, expect) {
      const result = await main.call<{
        pass: boolean;
        matched: number;
        sample: { id: string; kind: string; summary: string }[];
      }>('check', { filter, expect });
      state.step = `expectCheck ${short(filter)} ${short(expect)}`;
      if (!result.pass) {
        const lines = result.sample.map((line) => `${line.id} ${line.kind} ${line.summary}`);
        state.fail(
          `check failed: ${result.matched} matched${lines.length > 0 ? `\n${lines.join('\n')}` : ''}`,
        );
      }
    },
    async waitFor(filter, count = 1, timeoutMs) {
      const result = await main.call<{
        matched: number;
        timedOut: boolean;
        events: { id: string; kind: string; summary: string }[];
      }>('wait_for', { filter, count, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      state.step = `waitFor ${short(filter)}`;
      if (result.timedOut) state.fail(`wait_for timed out: ${result.matched} of ${count}`);
      return result;
    },
    equal(actual, expected, message) {
      state.step = message === undefined ? 'equal' : `equal (${message})`;
      if (!Bun.deepEquals(actual, expected)) {
        state.fail(`expected ${short(expected)}, got ${short(actual)}`);
      }
    },
    ok(condition, message) {
      state.step = message === undefined ? 'ok' : `ok (${message})`;
      if (!condition) state.fail(message ?? 'condition was false');
    },
  };
}

/**
 * After a scenario (passed or not): ends a Run still open, gives back the
 * lease and closes every session and connection it opened.
 */
export async function cleanUp(state: ScenarioState): Promise<void> {
  try {
    const status = await restCall<{ run: unknown }>(state.target, 'GET', '/status', {
      actor: 'ci',
    });
    if (status.body.run !== null) {
      for (const session of state.sessions) {
        const result = await session.tool('end_run').catch(() => undefined);
        if (result !== undefined && !result.isError) break;
      }
    }
  } catch {
    // The instance is gone; nothing to tidy there.
  }
  for (const session of state.sessions) {
    await session.tool('release_control').catch(() => undefined);
    await session.close().catch(() => undefined);
  }
  for (const socket of state.sockets) socket.close();
}
