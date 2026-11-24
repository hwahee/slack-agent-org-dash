/**
 * M1 (docs/spec.md §11): can the official MCP TypeScript SDK serve Streamable
 * HTTP from `Bun.serve`?
 *
 * Yes, with no Node `http` shim: the SDK's `WebStandardStreamableHTTPServerTransport`
 * takes a web `Request` and returns a web `Response`, which is exactly what a
 * `Bun.serve` route handler is. One transport (and one `McpServer`) per MCP
 * session; the `Mcp-Session-Id` header picks it.
 *
 * Checked two ways: raw HTTP (so the protocol details the control-plane lease
 * relies on are pinned down) and the SDK's own client over the default SSE
 * responses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { s } from '@shared/validation';

const SESSION_HEADER = 'mcp-session-id';

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'mcp-sdk-check', version: '0.0.0' });
  server.registerTool(
    'echo',
    {
      description: 'Returns the input text unchanged.',
      inputSchema: { text: s.string() },
    },
    ({ text }) => Promise.resolve({ content: [{ type: 'text', text }] }),
  );
  return server;
}

/** A `/mcp` route over the SDK's web-standard transport, one transport per session. */
function createMcpRoute(options: { enableJsonResponse: boolean }) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  async function handle(req: Request): Promise<Response> {
    const sessionId = req.headers.get(SESSION_HEADER);
    if (sessionId !== null) {
      const transport = sessions.get(sessionId);
      if (!transport) return new Response('Unknown MCP session', { status: 404 });
      return transport.handleRequest(req);
    }

    // No session yet: only an `initialize` POST may open one.
    const body: unknown = req.method === 'POST' ? await req.json() : undefined;
    if (!isInitializeRequest(body)) {
      return new Response('Mcp-Session-Id required', { status: 400 });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: options.enableJsonResponse,
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    await createMcpServer().connect(transport);
    return transport.handleRequest(req, { parsedBody: body });
  }

  return { handle, sessions };
}

const ACCEPT = 'application/json, text/event-stream';

let server: Bun.Server<undefined>;
let jsonRoute: ReturnType<typeof createMcpRoute>;
let mcpUrl: string;
let sseUrl: URL;

beforeAll(() => {
  jsonRoute = createMcpRoute({ enableJsonResponse: true });
  const sseRoute = createMcpRoute({ enableJsonResponse: false });
  server = Bun.serve({
    port: 0,
    routes: {
      '/mcp': (req) => jsonRoute.handle(req),
      '/mcp-sse': (req) => sseRoute.handle(req),
    },
    fetch: () => new Response('Not Found', { status: 404 }),
  });
  mcpUrl = new URL('/mcp', server.url).href;
  sseUrl = new URL('/mcp-sse', server.url);
});

afterAll(async () => {
  await server.stop(true);
});

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let nextId = 1;

async function rpc(
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<{ status: number; headers: Headers; body: JsonRpcResponse | undefined }> {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      ...(sessionId ? { [SESSION_HEADER]: sessionId, 'mcp-protocol-version': '2025-06-18' } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const text = await response.text();
  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;
  return {
    status: response.status,
    headers: response.headers,
    body: isJson && text ? (JSON.parse(text) as JsonRpcResponse) : undefined,
  };
}

async function notify(method: string, sessionId: string): Promise<number> {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      [SESSION_HEADER]: sessionId,
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method }),
  });
  await response.body?.cancel();
  return response.status;
}

/** initialize + notifications/initialized; returns the new session id. */
async function openSession(): Promise<string> {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw-http-test', version: '0.0.0' },
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get(SESSION_HEADER);
  if (!sessionId) throw new Error('initialize returned no Mcp-Session-Id');
  expect(await notify('notifications/initialized', sessionId)).toBe(202);
  return sessionId;
}

describe('MCP SDK over Bun.serve (raw Streamable HTTP)', () => {
  test('initialize opens a session and answers with Mcp-Session-Id', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'raw-http-test', version: '0.0.0' },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get(SESSION_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.body?.result).toMatchObject({ serverInfo: { name: 'mcp-sdk-check' } });
  });

  test('tools/list, tools/call twice on one session, then DELETE ends it', async () => {
    const sessionId = await openSession();

    const list = await rpc('tools/list', {}, sessionId);
    expect(list.status).toBe(200);
    const tools = (list.body?.result?.tools ?? []) as { name: string }[];
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);

    for (const text of ['hello', 'second call, same session']) {
      const call = await rpc('tools/call', { name: 'echo', arguments: { text } }, sessionId);
      expect(call.status).toBe(200);
      expect(call.body?.result).toEqual({ content: [{ type: 'text', text }] });
    }

    const closed = await fetch(mcpUrl, {
      method: 'DELETE',
      headers: { [SESSION_HEADER]: sessionId, 'mcp-protocol-version': '2025-06-18' },
    });
    expect(closed.status).toBe(200);
    expect(jsonRoute.sessions.has(sessionId)).toBe(false);

    const after = await rpc('tools/call', { name: 'echo', arguments: { text: 'x' } }, sessionId);
    expect(after.status).toBe(404);
  });

  test('a tool input that fails the schema is a tool error, not a crash', async () => {
    const sessionId = await openSession();
    const call = await rpc('tools/call', { name: 'echo', arguments: { text: 42 } }, sessionId);
    expect(call.status).toBe(200);
    expect(call.body?.result).toMatchObject({ isError: true });
  });

  test('a request without a session that is not initialize is refused', async () => {
    const response = await rpc('tools/list', {});
    expect(response.status).toBe(400);
  });
});

describe('MCP SDK over Bun.serve (SDK client, SSE responses)', () => {
  test('connect, list, call twice, terminate; the ended session is refused', async () => {
    const transport = new StreamableHTTPClientTransport(sseUrl);
    const client = new Client({ name: 'sdk-client-test', version: '0.0.0' });
    await client.connect(transport);
    const sessionId = transport.sessionId;
    expect(sessionId).toBeString();

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(await client.callTool({ name: 'echo', arguments: { text: 'a' } })).toEqual({
      content: [{ type: 'text', text: 'a' }],
    });
    expect(await client.callTool({ name: 'echo', arguments: { text: 'b' } })).toEqual({
      content: [{ type: 'text', text: 'b' }],
    });

    await transport.terminateSession();
    await client.close();

    const stale = await fetch(sseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        [SESSION_HEADER]: sessionId ?? '',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(stale.status).toBe(404);
  });
});
