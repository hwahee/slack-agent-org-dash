/**
 * The control lease (docs/testbed/control-plane.md §2).
 *
 * One holder at a time, identified by its MCP session id (agents) or a REST
 * lease id (CI). Every call the holder makes pushes the expiry out by the TTL;
 * with no calls the lease expires on its own. While it is held, operations by
 * anyone else are refused: `LOCKED` for people, `LEASE_HELD` for other agents
 * and CI. Reads stay open to all. People never take the lease.
 */
import type { Caller } from '@shared/testbed/events';
import type { LeaseView } from '@shared/testbed/lease';
import type { UtcIsoString } from '@shared/time';

import { TestbedError } from '../errors';
import type { EventBus } from '../events/bus';
import { publicCaller } from './caller';

const DEFAULT_LEASE_TTL_SEC = 600;

interface Holder {
  actor: Caller['actor'];
  name?: string;
  sessionId?: string;
  leaseId?: string;
}

export type ReleaseReason = 'released' | 'session-closed' | 'forced' | 'operation-failed';

function short(id: string | undefined): string {
  return (id ?? '').slice(0, 4);
}

/** `9:58` */
function minutes(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export class LeaseManager {
  private holder: Holder | null = null;
  private expiresAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly ttlMs: number;

  constructor(
    private readonly bus: EventBus,
    options: { ttlSec?: number } = {},
  ) {
    this.ttlMs = (options.ttlSec ?? DEFAULT_LEASE_TTL_SEC) * 1000;
  }

  view(): LeaseView | null {
    if (!this.holder) return null;
    const { actor, name, sessionId, leaseId } = this.holder;
    return {
      actor,
      ...(name === undefined ? {} : { name }),
      holder: short(sessionId ?? leaseId),
      expiresAt: new Date(this.expiresAt).toISOString() as UtcIsoString,
      remainingMs: Math.max(0, this.expiresAt - Date.now()),
    };
  }

  /** Whether `caller` is the current holder. */
  holds(caller: Caller): boolean {
    const holder = this.holder;
    if (!holder) return false;
    return (
      (holder.leaseId !== undefined && caller.leaseId === holder.leaseId) ||
      (holder.sessionId !== undefined && caller.sessionId === holder.sessionId)
    );
  }

  /**
   * Takes the lease (REST `POST /lease`, MCP `acquire_control`), or extends it
   * for the holder. A REST caller gets a new lease id; an MCP caller is known
   * by its session id.
   */
  acquire(caller: Caller, fn = 'acquireLease'): { leaseId?: string; expiresAt: UtcIsoString } {
    if (this.holder && !this.holds(caller)) throw this.deny(caller, fn);
    if (!this.holder) {
      const holder: Holder = {
        actor: caller.actor,
        ...(caller.name === undefined ? {} : { name: caller.name }),
        ...(caller.sessionId === undefined
          ? { leaseId: crypto.randomUUID() }
          : { sessionId: caller.sessionId }),
      };
      this.holder = holder;
      this.extend();
      this.bus.emit({
        core: 'testbed',
        kind: 'testbed.lease.acquired',
        actor: caller.actor,
        summary: `lease acquired by ${caller.actor}${caller.name === undefined ? '' : ` (${caller.name})`} ${short(holder.sessionId ?? holder.leaseId)}`,
        payload: { lease: this.view() },
      });
    } else {
      this.extend();
    }
    const holder = this.holder;
    return {
      ...(holder.leaseId === undefined ? {} : { leaseId: holder.leaseId }),
      expiresAt: new Date(this.expiresAt).toISOString() as UtcIsoString,
    };
  }

  /**
   * Gate for every control call. The holder's calls extend the lease. An
   * operation by anyone else while it is held is refused (and recorded); with
   * no lease, an MCP session's first operation takes it. Returns whether this
   * call took the lease, so a failed operation can give it back.
   */
  authorize(caller: Caller, fn: string, mutating: boolean): boolean {
    if (this.holds(caller)) {
      this.extend();
      return false;
    }
    if (!mutating) return false;
    if (!this.holder) {
      if (caller.sessionId === undefined) return false;
      this.acquire(caller, fn);
      return true;
    }
    throw this.deny(caller, fn);
  }

  /**
   * The operation that took the lease (`authorize` returned true) failed: the
   * lease goes back, so a refused call does not lock people out for the TTL.
   */
  undoAcquire(caller: Caller): void {
    if (this.holds(caller)) this.end('operation-failed', caller.actor);
  }

  /**
   * The holder gives the lease back (REST `DELETE /lease`, MCP
   * `release_control`). Anyone else has nothing to give back: `false`, not a
   * refusal — the lease stays with its holder either way.
   */
  release(caller: Caller): boolean {
    if (!this.holder || !this.holds(caller)) return false;
    this.end('released', caller.actor);
    return true;
  }

  /** The MCP session ended (`DELETE`): its lease goes with it. */
  releaseSession(sessionId: string): void {
    if (this.holder?.sessionId === sessionId) this.end('session-closed', 'agent');
  }

  /** `bun run testbed:release` — the emergency exit. */
  forceRelease(): boolean {
    if (!this.holder) return false;
    this.end('forced', 'system');
    return true;
  }

  /** Stops the expiry timer (shutdown, tests). */
  dispose(): void {
    clearTimeout(this.timer);
  }

  private extend(): void {
    this.expiresAt = Date.now() + this.ttlMs;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.expire(), this.ttlMs);
    this.timer.unref();
  }

  private expire(): void {
    const view = this.view();
    if (!view) return;
    this.holder = null;
    this.bus.emit({
      core: 'testbed',
      kind: 'testbed.lease.expired',
      actor: 'system',
      summary: `lease of ${view.actor} ${view.holder} expired after ${this.ttlMs / 1000}s without calls`,
      payload: { lease: view },
    });
  }

  private end(reason: ReleaseReason, actor: Caller['actor']): void {
    const view = this.view();
    clearTimeout(this.timer);
    this.holder = null;
    this.bus.emit({
      core: 'testbed',
      kind: 'testbed.lease.released',
      actor,
      summary: `lease of ${view?.actor ?? '?'} ${view?.holder ?? ''} released (${reason})`,
      payload: { lease: view, reason },
    });
  }

  /** Records the refusal and builds the error to throw. */
  private deny(caller: Caller, fn: string): TestbedError {
    const view = this.view();
    const code = caller.actor === 'human' ? 'LOCKED' : 'LEASE_HELD';
    const who = `${view?.actor ?? '?'}${view?.name === undefined ? '' : ` ${view.name}`} ${view?.holder ?? ''}`;
    const left = minutes(view?.remainingMs ?? 0);
    this.bus.emit({
      core: 'testbed',
      kind: 'testbed.lease.denied',
      level: 'warn',
      actor: caller.actor,
      summary: `${fn} by ${caller.actor} denied: lease held by ${who} (${left} left)`,
      payload: { fn, code, caller: publicCaller(caller), lease: view },
    });
    // An agent that reconnected (Claude Code restarted) meets the lease its
    // old session still holds: same client name, another session.
    const sameClient =
      code === 'LEASE_HELD' &&
      view?.actor === caller.actor &&
      view.name !== undefined &&
      view.name === caller.name &&
      this.holder?.sessionId !== undefined &&
      caller.sessionId !== undefined;
    const message =
      code === 'LOCKED'
        ? `제어 중(${who}, 남은 시간 ${left})이라 조작할 수 없음. 보기는 계속 가능. 제어가 끝나거나 만료되면 다시 시도`
        : sameClient
          ? `같은 이름(${view.name})의 다른 MCP 세션(${view.holder}, 남은 시간 ${left})이 제어 락을 가짐. 다시 연결하기 전의 옛 세션이면 그 세션은 호출이 없어도 남은 시간 동안 락을 쥠. 옛 세션이 아직 열려 있으면 그쪽에서 release_control, 아니면 테스트베드 서버가 도는 곳에서 \`bun run testbed:release\`로 풀고 다시 시도`
          : `다른 보유자가 제어 락을 가짐(${who}, 남은 시간 ${left}). 보유자가 해제하거나 만료된 뒤 다시 시도`;
    return new TestbedError(code, message, {
      holder: view,
      remainingMs: view?.remainingMs ?? 0,
      ...(sameClient ? { sameClient: true } : {}),
    });
  }
}
