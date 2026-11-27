/**
 * The agent core's own event payloads (docs/spec.md §6.2) and the health states
 * it judges (§5.3). Events moved over from the agent's diagnostics records keep
 * the record as their payload (§5.2); their shape is the agent's contract
 * (`slack-agent-org/src/diag/events.ts`), not repeated here.
 */

/** §5.3, first match wins top to bottom. */
export type AgentHealthState = 'absent' | 'stopped' | 'disconnected' | 'deaf' | 'ok';

export interface AgentHealth {
  state: AgentHealthState;
  /** One Korean sentence: why this state (e.g. `마지막 ping 31.2s 전`). */
  reason: string;
  /** Now − `status.json` `writtenAt`, ms; `null` without a snapshot. */
  snapshotAgeMs: number | null;
  /** Now − last Slack ping (else `connectedAt`), ms; `null` without a socket. */
  pingAgeMs: number | null;
  /** Now − last frame of any kind, ms. */
  frameAgeMs: number | null;
  conn: number | null;
  boot: string | null;
}

export interface AgentEventPayloads {
  'agent.health.changed': {
    from: AgentHealthState | null;
    to: AgentHealthState;
    reason: string;
    snapshotAgeMs: number | null;
    pingAgeMs: number | null;
    conn: number | null;
    boot: string | null;
  };
  'agent.record.invalid': { file: string; line: number; problem: string; preview: string };
  'agent.contract.mismatch': { file: string; found: unknown; expected: number };
  'agent.source.unreadable': { dataDir: string; error: string };
}

/** Extra fields on a moved-over record's payload (§5.2). */
export interface AgentRecordPayloadExtras {
  file: string;
  /** Read during the start-up backfill, not as it happened. */
  replayed: boolean;
}
