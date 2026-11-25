/**
 * The common testbed env (docs/testbed/architecture.md §7) — boot defaults
 * only; runtime changes go through the control API.
 */
import { s, toValidator, type Infer } from '@shared/validation';

const testbedConfigValidator = toValidator(
  s.object({
    bindHost: s.string().check(s.minLength(1)),
    publicUrl: s.url(),
    eventBuffer: s.int().check(s.gte(1)),
    runStore: s.enum(['memory', 'file']),
    dataDir: s.string().check(s.minLength(1)),
    runRetention: s.int().check(s.gte(1)),
    maxPayloadBytes: s.int().check(s.gte(1024)),
    /** Set → agents and CI need `Authorization: Bearer <token>`. */
    controlToken: s.optional(s.string().check(s.minLength(1))),
    leaseTtlSec: s.int().check(s.gte(1)),
    /** Open MCP sessions at most; a new `initialize` beyond it gets 503. */
    mcpMaxSessions: s.int().check(s.gte(1)),
    /** An MCP session with no requests for this long is closed by the server. */
    mcpSessionIdleSec: s.int().check(s.gte(1)),
    /** `TESTBED_EXAMPLE_CORES`: example cores under `examples/` to register too. */
    exampleCores: s.array(s.string().check(s.minLength(1))),
  }),
);

export type TestbedConfig = Infer<typeof testbedConfigValidator>;

/** Unset and empty both mean "use the default". */
function textOr(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

function intOr(value: string | undefined, fallback: number): number {
  return value === undefined || value === '' ? fallback : Number(value);
}

export function loadTestbedConfig(
  env: Record<string, string | undefined>,
  port: number,
): TestbedConfig {
  return testbedConfigValidator.parse({
    bindHost: textOr(env.TESTBED_BIND_HOST, '127.0.0.1'),
    publicUrl: textOr(env.TESTBED_PUBLIC_URL, `http://localhost:${port}`),
    eventBuffer: intOr(env.TESTBED_EVENT_BUFFER, 5000),
    runStore: textOr(env.TESTBED_RUN_STORE, 'memory'),
    dataDir: textOr(env.TESTBED_DATA_DIR, './data'),
    runRetention: intOr(env.TESTBED_RUN_RETENTION, 50),
    maxPayloadBytes: intOr(env.TESTBED_MAX_PAYLOAD_BYTES, 16_384),
    controlToken: env.TESTBED_CONTROL_TOKEN === '' ? undefined : env.TESTBED_CONTROL_TOKEN,
    leaseTtlSec: intOr(env.TESTBED_LEASE_TTL_SEC, 600),
    mcpMaxSessions: intOr(env.TESTBED_MCP_MAX_SESSIONS, 32),
    mcpSessionIdleSec: intOr(env.TESTBED_MCP_SESSION_IDLE_SEC, 3600),
    exampleCores: (env.TESTBED_EXAMPLE_CORES ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  });
}
