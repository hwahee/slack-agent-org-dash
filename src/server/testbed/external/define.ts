/**
 * Declaring an external core (docs/testbed/external-core-protocol.md §2):
 * only what the glue needs to start the process. The config schema, the
 * defaults, the actions and the fault kinds come from the process's
 * `initialize` answer.
 */
import type { CoreKind } from '@shared/testbed/core';
import { s, toValidator, type Infer } from '@shared/validation';

export interface ExternalCoreDeclaration {
  /** Same rule as in-proc cores: `^[a-z][a-z0-9-]*$`, not `testbed`. */
  id: string;
  /** Must equal what `initialize` answers, or the core goes to `error`. */
  kind: CoreKind;
  title: string;
  /** Run from the repository root, e.g. `['python3', '-u', 'examples/python-core/echo_core.py']`. */
  command: readonly string[];
  /** Fixed values passed to the process on top of the allowed environment. */
  env?: Record<string, string>;
}

export interface ExternalCoreDefinition extends ExternalCoreDeclaration {
  external: true;
}

export function defineExternalCore(declaration: ExternalCoreDeclaration): ExternalCoreDefinition {
  return { ...declaration, external: true };
}

/** The fields the glue adds to an external core's config (protocol §2.1). */
export const GLUE_KEYS = [
  'replicas',
  'restart',
  'maxRestarts',
  'pingIntervalMs',
  'pingTimeoutMs',
  'requestTimeoutMs',
  'shutdownGraceMs',
] as const;

export const glueConfigValidator = toValidator(
  s.object({
    replicas: s.int().check(s.gte(1), s.lte(16)),
    restart: s.enum(['never', 'on-failure']),
    maxRestarts: s.int().check(s.gte(0), s.lte(100)),
    pingIntervalMs: s.int().check(s.gte(1000), s.lte(60_000)),
    pingTimeoutMs: s.int().check(s.gte(100), s.lte(30_000)),
    requestTimeoutMs: s.int().check(s.gte(1000), s.lte(300_000)),
    shutdownGraceMs: s.int().check(s.gte(0), s.lte(60_000)),
  }),
);

export type GlueConfig = Infer<typeof glueConfigValidator>;

/** `py-echo` → `PY_ECHO` (the prefix of the core's environment variables). */
function envPrefix(coreId: string): string {
  return coreId.toUpperCase().replaceAll('-', '_');
}

function intOr(value: string | undefined, fallback: number): number {
  return value === undefined || value === '' ? fallback : Number(value);
}

/** The glue fields' boot defaults, three of them from `<CORE_ID>_*` (protocol §2.1). */
export function glueDefaults(coreId: string, env: Record<string, string | undefined>): GlueConfig {
  const prefix = envPrefix(coreId);
  const restart = env[`${prefix}_RESTART`];
  return glueConfigValidator.parse({
    replicas: intOr(env[`${prefix}_REPLICAS`], 1),
    restart: restart === undefined || restart === '' ? 'on-failure' : restart,
    maxRestarts: intOr(env[`${prefix}_MAX_RESTARTS`], 5),
    pingIntervalMs: 5000,
    pingTimeoutMs: 3000,
    requestTimeoutMs: 30_000,
    shutdownGraceMs: 5000,
  });
}

const PASSED_THROUGH = ['PATH', 'HOME', 'LANG', 'TZ'] as const;

/**
 * The process's environment: `PATH`, `HOME`, `LANG`, `TZ`, the core's own
 * `<CORE_ID>_*` variables and the declaration's `env` — nothing else, so
 * control-plane secrets (`TESTBED_CONTROL_TOKEN`) never reach a core.
 * `PATH` and the rest fall back to this process's when `env` lacks them.
 */
export function processEnv(
  declaration: ExternalCoreDeclaration,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = env[name] ?? process.env[name];
    if (value !== undefined) out[name] = value;
  }
  const prefix = `${envPrefix(declaration.id)}_`;
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(prefix) && value !== undefined) out[name] = value;
  }
  return { ...out, ...declaration.env };
}
