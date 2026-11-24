/**
 * `/testbed/mcp` — the control plane over MCP Streamable HTTP
 * (docs/testbed/control-plane.md §4).
 *
 * The SDK's web-standard transport sits directly on the `Bun.serve` route
 * (docs/spec.md §2, M1). One transport and one MCP server per session; the
 * `Mcp-Session-Id` header picks it, and the session id is the lease holder's
 * identity. A session ends on `DELETE`, after `TESTBED_MCP_SESSION_IDLE_SEC`
 * without requests, or on shutdown — and takes its lease with it.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { Caller } from '@shared/testbed/events';

import type { ControlService } from '../control/service';
import { controlTokenOk, type ControlAuth } from '../http/auth';
import { createTools, errorResult, type McpTool, type ToolResult } from './tools';

const SESSION_HEADER = 'mcp-session-id';

/** Sent with `initialize` as is (docs/spec.md §11 M5). */
export const MCP_INSTRUCTIONS =
  '테스트베드 제어면입니다. 처음엔 `testbed_info`로 코어·데이터면 주소·락 상태를 봅니다. 시험은 `start_run` → 제품 작업 → `query_events`/`wait_for`/`check` → `end_run` 순서로 합니다. 조작 도구는 첫 호출 때 제어 락을 잡고, 그동안 사람은 대시보드에서 조작할 수 없습니다. 끝나면 `release_control`을 부릅니다.';

export interface McpEndpointOptions {
  control: ControlService;
  auth: ControlAuth;
  name: string;
  version: string;
  /** `TESTBED_MCP_MAX_SESSIONS` */
  maxSessions: number;
  /** `TESTBED_MCP_SESSION_IDLE_SEC` */
  sessionIdleSec: number;
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  timer?: ReturnType<typeof setTimeout>;
  /** Tool calls still running; a session is never idle while one is. */
  inflight: number;
}

function rpcError(status: number, code: number, message: string, id: unknown = null): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id }), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
    },
  });
}

export class McpEndpoint {
  private readonly sessions = new Map<string, Session>();
  /** `initialize` requests not answered yet — they count toward the cap. */
  private opening = 0;
  private readonly tools: Map<string, McpTool>;
  private readonly idleMs: number;

  constructor(private readonly options: McpEndpointOptions) {
    this.tools = createTools(options.control);
    this.idleMs = options.sessionIdleSec * 1000;
  }

  /** How many sessions are open. */
  get size(): number {
    return this.sessions.size;
  }

  async handle(req: Request, server?: Bun.Server<unknown>): Promise<Response> {
    if (!controlTokenOk(req, this.options.auth)) {
      return rpcError(
        401,
        -32001,
        'Unauthorized: Authorization: Bearer <TESTBED_CONTROL_TOKEN> 필요',
      );
    }
    // `wait_for` may be silent for up to 120 s; Bun's idle timeout is 10 s.
    server?.timeout(req, 0);

    const sessionId = req.headers.get(SESSION_HEADER);
    if (sessionId !== null) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return rpcError(404, -32001, 'Session not found: 세션이 끝났음. 새로 initialize');
      }
      this.touch(sessionId, session);
      return session.transport.handleRequest(req);
    }
    return this.open(req);
  }

  /** Closes every session (shutdown, tests); their leases go with them. */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  private async open(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return rpcError(400, -32000, 'Bad Request: Mcp-Session-Id 헤더가 필요함. 먼저 initialize');
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return rpcError(400, -32700, 'Parse error');
    }
    if (!isInitializeRequest(body)) {
      return rpcError(400, -32000, 'Bad Request: Mcp-Session-Id 헤더가 필요함. 먼저 initialize');
    }
    const { maxSessions } = this.options;
    if (this.sessions.size + this.opening >= maxSessions) {
      return rpcError(
        503,
        -32000,
        `MCP 세션이 상한(${maxSessions})에 도달함. 쓰지 않는 세션을 닫거나(\`DELETE\`) 잠시 뒤 다시 시도`,
        (body as { id?: unknown }).id,
      );
    }

    const server = this.createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        const session: Session = { transport, server, inflight: 0 };
        this.sessions.set(id, session);
        this.touch(id, session);
      },
      onsessionclosed: (id) => {
        this.forget(id);
      },
    });
    this.opening += 1;
    try {
      await server.connect(transport);
      return await transport.handleRequest(req, { parsedBody: body });
    } finally {
      this.opening -= 1;
    }
  }

  private createServer(): Server {
    // The low-level server: tools are described by our own JSON Schemas and
    // validated by the control service, so failures carry our error codes
    // (the high-level McpServer would answer bad input with its own text).
    const server = new Server(
      { name: this.options.name, version: this.options.version },
      { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this.tools.values()].map((entry) => ({
        name: entry.name,
        description: entry.description,
        inputSchema: entry.inputSchema as { type: 'object' },
        annotations: { readOnlyHint: entry.readOnly },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const entry = this.tools.get(request.params.name);
      if (!entry) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
      }
      const sessionId = extra.sessionId ?? '';
      const name = server.getClientVersion()?.name;
      const caller: Caller = { actor: 'agent', sessionId, ...(name === undefined ? {} : { name }) };
      const session = this.sessions.get(sessionId);
      if (session) session.inflight += 1;
      try {
        const out = await entry.call(request.params.arguments, caller);
        const result: ToolResult = {
          content: [{ type: 'text', text: out.text }],
          structuredContent: out.structured,
        };
        return result;
      } catch (error) {
        return errorResult(error);
      } finally {
        if (session) {
          session.inflight -= 1;
          this.touch(sessionId, session);
        }
      }
    });
    return server;
  }

  /** Re-arms the idle timer. */
  private touch(id: string, session: Session): void {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (session.inflight > 0) this.touch(id, session);
      else void this.close(id);
    }, this.idleMs);
    session.timer.unref();
  }

  /** Server-side close (idle, shutdown). */
  private async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.forget(id);
    await session.transport.close();
  }

  /** Drops the session and the lease it held. */
  private forget(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    this.sessions.delete(id);
    this.options.control.lease.releaseSession(id);
  }
}
