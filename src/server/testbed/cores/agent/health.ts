/**
 * The receive-health judgment (docs/spec.md §5.3): from the agent's status
 * snapshot and the current time, the first matching state top to bottom.
 * Pure — the core reads the file and the clock.
 */
import type { AgentHealth } from '@shared/testbed/cores/agent/events';
import { validateSnapshot, type StatusSnapshot } from 'slack-agent-org/src/diag/events';

import { secs } from './describe';

export interface HealthLimits {
  pingStaleSec: number;
  snapshotStaleSec: number;
}

/** What the core read for `status.json`: the parsed JSON, or why there is none. */
export type SnapshotRead = { ok: true; value: unknown } | { ok: false; why: string };

const ageOf = (now: number, iso: string | null | undefined): number | null =>
  iso === null || iso === undefined ? null : now - Date.parse(iso);

export function judgeHealth(read: SnapshotRead, now: number, limits: HealthLimits): AgentHealth {
  const blank = { snapshotAgeMs: null, pingAgeMs: null, frameAgeMs: null, conn: null, boot: null };
  if (!read.ok) return { state: 'absent', reason: read.why, ...blank };
  const checked = validateSnapshot(read.value);
  if (!checked.ok) {
    return { state: 'absent', reason: `status.json 형식이 다름: ${checked.problem}`, ...blank };
  }
  const snapshot = read.value as StatusSnapshot;
  const socket = snapshot.sections.socket;
  const snapshotAgeMs = ageOf(now, snapshot.writtenAt);
  const pingAgeMs = socket ? ageOf(now, socket.lastPingAt ?? socket.connectedAt) : null;
  const facts = {
    snapshotAgeMs,
    pingAgeMs,
    frameAgeMs: socket ? ageOf(now, socket.lastFrameAt) : null,
    conn: socket?.conn ?? null,
    boot: snapshot.boot,
  };

  if (snapshotAgeMs !== null && snapshotAgeMs > limits.snapshotStaleSec * 1000) {
    return { state: 'stopped', reason: `스냅샷 ${secs(snapshotAgeMs)} 전`, ...facts };
  }
  if (!socket) return { state: 'disconnected', reason: '소켓 정보 없음', ...facts };
  if (!socket.live) return { state: 'disconnected', reason: '소켓 live=false', ...facts };
  if (pingAgeMs === null || pingAgeMs > limits.pingStaleSec * 1000) {
    return {
      state: 'deaf',
      reason:
        pingAgeMs === null ? '연결됐지만 ping 기록이 없음' : `마지막 ping ${secs(pingAgeMs)} 전`,
      ...facts,
    };
  }
  return { state: 'ok', reason: `정상 (ping ${secs(pingAgeMs)} 전)`, ...facts };
}
