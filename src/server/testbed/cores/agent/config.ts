/**
 * Agent core config (docs/spec.md §7) and its env defaults.
 */
import { faultRuleSchema } from '@shared/testbed/faults';
import { s, toValidator, type Infer } from '@shared/validation';

export const agentConfigValidator = toValidator(
  s.object({
    /** The agent's DATA_DIR; its `diag/` folder is read, never written. */
    dataDir: s.string().check(s.minLength(1)),
    pollMs: s.int().check(s.gte(200), s.lte(60_000)),
    backfillMinutes: s.int().check(s.gte(0), s.lte(10_080)),
    pingStaleSec: s.int().check(s.gte(5), s.lte(600)),
    snapshotStaleSec: s.int().check(s.gte(6), s.lte(600)),
    autoStart: s.boolean(),
    eventLevel: s.enum(['debug', 'info']),
    /** No fault kinds are declared, so any rule fails validation (§8). */
    faults: s.array(faultRuleSchema),
  }),
);

export type AgentConfig = Infer<typeof agentConfigValidator>;

function intFrom(value: string | undefined, fallback: number): number {
  return value === undefined || value === '' ? fallback : Number(value);
}

/** Raw defaults; the host validates them, so a bad env value fails the boot. */
export function agentDefaultConfig(env: Record<string, string | undefined>): unknown {
  return {
    dataDir:
      env.AGENT_DATA_DIR === undefined || env.AGENT_DATA_DIR === ''
        ? '../slack-agent-org/data'
        : env.AGENT_DATA_DIR,
    pollMs: intFrom(env.AGENT_POLL_MS, 1_000),
    backfillMinutes: intFrom(env.AGENT_BACKFILL_MINUTES, 180),
    pingStaleSec: intFrom(env.AGENT_PING_STALE_SEC, 30),
    snapshotStaleSec: intFrom(env.AGENT_SNAPSHOT_STALE_SEC, 20),
    autoStart: env.AGENT_AUTO_START === undefined ? true : env.AGENT_AUTO_START !== 'false',
    eventLevel: 'info',
    faults: [],
  };
}
