/**
 * The short texts MCP tools put in `content` (docs/testbed/control-plane.md §4):
 * people and agents read these; programs read `structuredContent`.
 */
import type { CoreLog } from '@shared/testbed/control';
import type { CoreStatus } from '@shared/testbed/core';
import type { EventLine } from '@shared/testbed/events';
import type { LeaseView } from '@shared/testbed/lease';
import type { RunMeta } from '@shared/testbed/runs';

/** `9:58` */
function minutes(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** `<id> <HH:MM:SS.mmm> <level> <kind> <summary>`, time in UTC. */
export function eventLineText(line: EventLine): string {
  return `${line.id} ${line.ts.slice(11, 23)} ${line.level} ${line.kind} ${line.summary}`;
}

export function eventLinesText(lines: readonly EventLine[]): string {
  return lines.length === 0 ? '(no events)' : lines.map(eventLineText).join('\n');
}

/**
 * `sample running tcp://127.0.0.1:40001 actions: broadcast`; an external core
 * adds its replicas: `py-echo running x2 (r0 running pid 123, r1 running pid 124) …`.
 */
export function coreText(core: CoreStatus, actions: readonly string[]): string {
  const parts = [core.id, core.state];
  if (core.detail !== undefined) parts.push(`(${core.detail})`);
  if (core.external && core.replicas) {
    const each = core.replicas.map((replica) =>
      [
        replica.id,
        replica.state,
        ...(replica.pid === undefined ? [] : [`pid ${replica.pid}`]),
      ].join(' '),
    );
    parts.push(`x${core.replicas.length}`, `(${each.join(', ')})`);
  }
  parts.push(...core.endpoints.map((endpoint) => endpoint.url));
  if (actions.length > 0) parts.push(`actions: ${actions.join(', ')}`);
  return parts.join(' ');
}

/** Each replica's lines under a `r0 (3 lines)` header; an in-proc core's note. */
export function coreLogText(log: CoreLog): string {
  if (!log.external) return `${log.core}: ${log.note ?? ''}`;
  return log.replicas
    .map(({ replica, lines }) =>
      [`${log.core} ${replica} (${lines.length} lines)`, ...lines.map((line) => `  ${line}`)].join(
        '\n',
      ),
    )
    .join('\n');
}

export function runText(run: RunMeta | null): string {
  return run === null
    ? 'run: none'
    : `run: ${run.runId} '${run.label}' (seed ${run.seed}, opened by ${run.openedBy.actor} at ${run.startedAt})`;
}

export function leaseText(lease: LeaseView | null): string {
  if (lease === null) return 'lease: none';
  const name = lease.name === undefined ? '' : ` ${lease.name}`;
  return `lease: ${lease.actor}${name} ${lease.holder} (${minutes(lease.remainingMs)} left)`;
}

/** The closed Run with its summary. */
export function endedRunText(run: RunMeta): string {
  const lines = [`Run ${run.runId} '${run.label}' ${run.endReason ?? 'ended'}`];
  const summary = run.summary;
  if (summary) {
    const total = Object.values(summary.byKind).reduce((sum, n) => sum + n, 0);
    lines.push(`${total} events in ${(summary.durationMs / 1000).toFixed(1)}s`);
    const kinds = Object.entries(summary.byKind)
      .sort(([, a], [, b]) => b - a)
      .map(([kind, n]) => `${kind}=${n}`);
    if (kinds.length > 0) lines.push(`kinds: ${kinds.join(', ')}`);
    for (const error of summary.topErrors) {
      lines.push(`error ${error.kind} ×${error.count}: ${error.summary}`);
    }
    for (const check of summary.checks) {
      lines.push(
        `check${check.label === undefined ? '' : ` '${check.label}'`}: ${check.pass ? 'pass' : 'FAIL'} (${check.matched} matched)`,
      );
    }
  }
  return lines.join('\n');
}
