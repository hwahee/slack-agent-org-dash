/**
 * A fake external core for the common runtime's tests (docs/spec.md §11 P4).
 * Run with `bun`; `<CORE_ID>_MODE` (e.g. `FAKE_MODE`) picks a misbehaviour:
 *
 *   (`<CORE_ID>_MODE_R1` sets one replica's mode)
 *
 *   normal             speaks the protocol; action `echo {text}` → `{ text, replica }`
 *   crash-after-start  answers `start`, then exits with code 3
 *   hang-status        never answers `status`
 *   bad-stdout         writes a non-protocol line and a line over 1 MiB to stdout
 *   wrong-kind         answers `initialize` with another `kind`
 *   reserved-field     puts `replicas` in its config schema
 *   slow-action        answers actions after `<CORE_ID>_SLOW_MS` (default 1500)
 *   ignore-shutdown    answers `shutdown` but stays (and ignores SIGTERM)
 *   print-env          sends the names of its environment variables as an event
 *
 * More actions for tests: `emit`, `fault`, `fail {code}`, `stderr {line}`, `seen`.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { fakeInitializeResult } from './fake-core-spec';

interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

const env = process.env;
let coreId = 'fake';
let replicaId = 'r0';
let replicaIndex = 0;
let mode = 'normal';
let running = false;
let calls = 0;
let config: Record<string, unknown> = {};
const seeds: string[] = [];
const runIds: (string | null)[] = [];

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function notify(method: string, params: Record<string, unknown>): void {
  send({ method, params });
}

function prefix(id: string): string {
  return id.toUpperCase().replaceAll('-', '_');
}

async function action(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (mode === 'slow-action') await sleep(Number(env[`${prefix(coreId)}_SLOW_MS`] ?? 1500));
  switch (name) {
    case 'echo':
      return { text: input.text, replica: replicaId };
    case 'emit':
      notify('event', {
        kind: typeof input.kind === 'string' ? input.kind : `${coreId}.thing.happened`,
        level: typeof input.level === 'string' ? input.level : 'info',
        summary: `${replicaId} emitted`,
        payload: { replicaIndex, authorization: 'Bearer sk-secret-value-123' },
        correlationId: 'c-1',
      });
      return {};
    case 'fault':
      notify('fault', {
        ruleId: 'f1',
        effects: { disconnect: true },
        selector: { connId: 'c-1' },
        correlationId: 'c-1',
      });
      return {};
    case 'fail':
      throw Object.assign(new Error(`failed on purpose with ${String(input.code)}`), {
        code: String(input.code),
      });
    case 'stderr':
      process.stderr.write(`${String(input.line)}\n`);
      return {};
    case 'seen':
      return { seeds, runIds };
    default:
      throw Object.assign(new Error(`no action ${name}`), { code: 'NO_ACTION' });
  }
}

async function handle(request: Request): Promise<unknown> {
  const { method, params } = request;
  calls += 1;
  switch (method) {
    case 'initialize':
      coreId = String(params.coreId);
      replicaId = String(params.replicaId);
      replicaIndex = Number(params.replicaIndex);
      // `<ID>_MODE_R1` gives one replica its own mode.
      mode =
        env[`${prefix(coreId)}_MODE_${replicaId.toUpperCase()}`] ??
        env[`${prefix(coreId)}_MODE`] ??
        'normal';
      seeds.push(String(params.seed));
      runIds.push((params.runId as string | null) ?? null);
      if (mode === 'ignore-shutdown') process.on('SIGTERM', () => undefined);
      return fakeInitializeResult(mode, coreId, env);
    case 'applyConfig':
      config = (params.config as Record<string, unknown> | undefined) ?? {};
      return { result: 'applied' };
    case 'start':
      running = true;
      if (mode === 'crash-after-start') {
        setTimeout(() => {
          process.stderr.write('crashing on purpose\n');
          process.exit(3);
        }, 50);
      }
      return {};
    case 'stop':
      running = false;
      return {};
    case 'reset':
      calls = 0;
      return {};
    case 'status':
      if (mode === 'hang-status') return new Promise(() => undefined);
      return {
        state: running ? 'running' : 'stopped',
        endpoints: [
          { name: 'main', protocol: 'tcp', url: `tcp://127.0.0.1:${9000 + replicaIndex}` },
        ],
        counters: { calls, limit: Number(config.limit ?? 0) },
      };
    case 'action':
      return action(
        String(params.name),
        (params.input as Record<string, unknown> | undefined) ?? {},
      );
    case 'runChanged':
      seeds.push(String(params.seed));
      runIds.push((params.runId as string | null) ?? null);
      return {};
    case 'shutdown':
      if (mode !== 'ignore-shutdown') setTimeout(() => process.exit(0), 10);
      return {};
    default:
      throw Object.assign(new Error(`unknown method ${method}`), { code: 'NO_METHOD' });
  }
}

function afterInitialize(): void {
  if (mode === 'bad-stdout') {
    process.stdout.write('this is not JSON-RPC\n');
    process.stdout.write(`${'x'.repeat(1024 * 1024 + 10)}\n`);
  }
  if (mode === 'print-env') {
    notify('event', {
      kind: `${coreId}.env.listed`,
      summary: 'environment variable names',
      payload: { names: Object.keys(env).sort() },
    });
  }
}

async function main(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim() === '') continue;
      const request = JSON.parse(line) as Request;
      void handle(request).then(
        (result) => {
          send({ id: request.id, result });
          if (request.method === 'initialize') afterInitialize();
        },
        (error: unknown) => {
          const code = (error as { code?: string }).code ?? 'INTERNAL';
          send({
            id: request.id,
            error: {
              code: -32_000,
              message: error instanceof Error ? error.message : String(error),
              data: { code },
            },
          });
        },
      );
    }
  }
}

await main();
