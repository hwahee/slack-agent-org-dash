/**
 * How one of the agent's diagnostics records becomes a testbed event: level,
 * summary, correlation id and latency (docs/spec.md §5.2, §6.1). Pure.
 */
import type { EventLevel } from '@shared/testbed/events';
import type { DiagEvents, DiagKind, DiagRecord } from 'slack-agent-org/src/diag/events';

export interface RecordView {
  level: EventLevel;
  summary: string;
  correlationId?: string;
  latencyMs?: number;
}

/** Seconds with one decimal, e.g. `4.2s`. */
export function secs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '?' : `${(ms / 1000).toFixed(1)}s`;
}

type Fields<K extends DiagKind> = DiagEvents[K];

function view<K extends DiagKind>(kind: K, r: Fields<K>): RecordView {
  switch (kind) {
    case 'process.booted': {
      const f = r as Fields<'process.booted'>;
      return { level: 'info', summary: `에이전트 시작 (pid ${f.pid}, bun ${f.bunVersion})` };
    }
    case 'process.shutdown': {
      const f = r as Fields<'process.shutdown'>;
      return {
        level: f.phase === 'forced' ? 'warn' : 'info',
        summary: `에이전트 종료 ${f.phase} (${f.signal})`,
      };
    }
    case 'clock.gap': {
      const f = r as Fields<'clock.gap'>;
      return {
        level: 'info',
        summary: `에이전트가 ${secs(f.wallElapsedMs)} 멈춤 (잠자기 의심)`,
      };
    }
    case 'desk.state': {
      const f = r as Fields<'desk.state'>;
      return f.ready
        ? { level: 'info', summary: '데스크 준비됨' }
        : { level: 'warn', summary: `데스크 막힘: ${f.problem ?? '?'}` };
    }
    case 'socket.url-requested': {
      const f = r as Fields<'socket.url-requested'>;
      return f.ok
        ? { level: 'debug', summary: `소켓 주소 요청 #${f.conn} 성공 ${f.ms}ms` }
        : { level: 'warn', summary: `소켓 주소 요청 #${f.conn} 실패: ${f.error ?? '?'}` };
    }
    case 'socket.opened': {
      const f = r as Fields<'socket.opened'>;
      return { level: 'debug', summary: `소켓 열림 #${f.conn}` };
    }
    case 'socket.hello': {
      const f = r as Fields<'socket.hello'>;
      return {
        level: (f.numConnections ?? 1) > 1 ? 'warn' : 'info',
        summary: `소켓 연결 #${f.conn} (연결 수 ${f.numConnections ?? '?'})`,
      };
    }
    case 'socket.disconnect-requested': {
      const f = r as Fields<'socket.disconnect-requested'>;
      return { level: 'info', summary: `Slack이 재연결 요청 #${f.conn} (${f.reason ?? '?'})` };
    }
    case 'socket.error': {
      const f = r as Fields<'socket.error'>;
      return { level: 'warn', summary: `소켓 오류 #${f.conn}: ${f.message}` };
    }
    case 'socket.closed': {
      const f = r as Fields<'socket.closed'>;
      return {
        level: f.code === 1000 ? 'info' : 'warn',
        summary: `소켓 닫힘 #${f.conn} code ${f.code}, ${secs(f.livedMs)} 유지, 마지막 프레임 ${secs(f.lastFrameAgoMs)} 전`,
      };
    }
    case 'socket.reconnect-scheduled': {
      const f = r as Fields<'socket.reconnect-scheduled'>;
      return { level: 'info', summary: `재연결 예약 ${f.delayMs}ms 뒤 (시도 ${f.attempt})` };
    }
    case 'socket.reconnect-failed': {
      const f = r as Fields<'socket.reconnect-failed'>;
      return { level: 'warn', summary: `재연결 실패: ${f.error}` };
    }
    case 'socket.envelope': {
      const f = r as Fields<'socket.envelope'>;
      const retried = (f.retryAttempt ?? 0) > 0;
      const correlationId =
        f.channel !== undefined && f.ts !== undefined ? `${f.channel}:${f.ts}` : undefined;
      return {
        level: retried ? 'warn' : 'debug',
        summary: retried
          ? `envelope ${f.type} 재전송 ${f.retryAttempt}회째 (${f.retryReason ?? '?'})`
          : `envelope ${f.type}`,
        ...(correlationId !== undefined && { correlationId }),
      };
    }
    case 'socket.frame-unreadable': {
      const f = r as Fields<'socket.frame-unreadable'>;
      return { level: 'warn', summary: `읽을 수 없는 프레임 #${f.conn} (${f.bytes}B)` };
    }
    case 'message.observed': {
      const f = r as Fields<'message.observed'>;
      const rescued = f.path === 'catchup' && (f.outcome === 'queued' || f.outcome === 'overheard');
      const level: EventLevel = rescued
        ? 'warn'
        : f.path === 'socket' && f.deliver
          ? 'info'
          : 'debug';
      const via = f.path === 'socket' ? '소켓으로' : '따라잡기로';
      return {
        level,
        summary: `메시지 ${via} 받음 ${f.id}, ${secs(f.delayMs)} 늦음 → ${f.outcome}`,
        correlationId: f.id,
        latencyMs: f.delayMs,
      };
    }
    case 'inbox.taken': {
      const f = r as Fields<'inbox.taken'>;
      const longest = f.messages.reduce((max, m) => Math.max(max, m.waitedMs), 0);
      const only = f.messages.length === 1 ? f.messages[0]?.id : undefined;
      return {
        level: 'info',
        summary: `대기열에서 ${f.messages.length}건 꺼냄 (${f.by})`,
        latencyMs: longest,
        ...(only !== undefined && { correlationId: only }),
      };
    }
    case 'turn.started': {
      const f = r as Fields<'turn.started'>;
      return {
        level: 'info',
        summary: `턴 시작 ${f.conversation} (${f.cause}, 메시지 ${f.messageIds.length}건)`,
      };
    }
    case 'turn.ended': {
      const f = r as Fields<'turn.ended'>;
      return {
        level: f.ok ? 'info' : 'warn',
        summary: `턴 끝 ${f.conversation} ${secs(f.ms)}${f.ok ? '' : ' 실패'}`,
        latencyMs: f.ms,
      };
    }
    case 'triage.decided': {
      const f = r as Fields<'triage.decided'>;
      return {
        level: f.outcome === 'failed' || f.outcome === 'unreadable' ? 'warn' : 'info',
        summary: `채널 판단 ${f.conversation}: ${f.outcome}`,
      };
    }
    case 'poll.ran': {
      const f = r as Fields<'poll.ran'>;
      return {
        level: f.tasks.some((task) => !task.ok) ? 'warn' : 'debug',
        summary: `폴링 ${f.ms}ms${f.skipped ? ' (건너뜀)' : ''}`,
      };
    }
    case 'catchup.ran': {
      const f = r as Fields<'catchup.ran'>;
      if (f.error !== undefined) {
        return { level: 'warn', summary: `따라잡기 (${f.trigger}) 실패: ${f.error}` };
      }
      return {
        level: (f.found ?? 0) > 0 ? 'info' : 'debug',
        summary: `따라잡기 (${f.trigger}) ${f.found ?? 0}건 찾음`,
      };
    }
    case 'heartbeat.beat': {
      const f = r as Fields<'heartbeat.beat'>;
      return {
        level: f.outcome === 'working' ? 'debug' : 'warn',
        summary: `하트비트 ${f.outcome}${f.problem !== undefined ? `: ${f.problem}` : ''}`,
      };
    }
    default:
      // A kind the pinned contract does not list (added upstream in the same version).
      return { level: 'info', summary: String(kind) };
  }
}

/** The event view of a record already checked with `validateRecord`. */
export function describeRecord(record: DiagRecord, replayed: boolean): RecordView {
  const result = view(record.kind, record as unknown as Fields<typeof record.kind>);
  return replayed ? { ...result, summary: `[지난 기록] ${result.summary}` } : result;
}
