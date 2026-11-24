/**
 * ═══════════════════════════════════════════════════════════════════════════
 * API CATALOG — every server endpoint the client uses, in ONE place.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Conventions (shared with the server, see src/shared/api):
 *   - List endpoints take `page`, `pageSize`, `sortBy`, `sortOrder` plus
 *     endpoint-specific flat filter params, and return the `Page<T>` envelope.
 *   - Errors always arrive as `{ error: { code, message, details? } }` and are
 *     surfaced as `ApiRequestError` (src/client/api/http.ts).
 *   - All timestamps are UTC ISO strings; format them for display with
 *     `formatUtcInTimeZone` (@shared/time) — never re-interpret on the client.
 *
 * Adding an endpoint? Define it here with a doc comment like the ones below;
 * components must import from this module (or the query hooks built on it in
 * ./queries.ts), never call `fetch` directly.
 */
import { appearanceParams, type Appearance } from '@shared/domain/appearance';
import type { Sitemap } from '@shared/domain/sitemap';
import type { User } from '@shared/domain/user';
import type { TestbedManifest, TestbedStatus } from '@shared/testbed/control';
import type { CoreStatus } from '@shared/testbed/core';
import type { EventFilter, EventLine, TestbedEvent } from '@shared/testbed/events';
import type { RunMeta } from '@shared/testbed/runs';

import { ApiRequestError, apiFetch } from './http';

/**
 * Sign-in. Members sign in and out on the member server (CLAUDE.md): the
 * browser navigates there and back, so signing in and out are addresses to
 * go to, not calls. The session then travels as an httpOnly cookie the
 * browser sends on its own (same-origin) — no call here handles a token.
 *
 * These endpoints exist only when the server runs with `AUTH_DRIVER=oidc`;
 * otherwise every one of them answers 404 `NOT_FOUND`.
 */
export const authApi = {
  /**
   * `GET /api/auth/login?returnTo=&theme=&design=&ui_locales=` — navigate here
   * (full page) to sign in.
   *
   * Goes to the member server's sign-in page, which looks the way
   * `appearance` says (@shared/domain/appearance), and comes back to
   * `returnTo` (a path on this site) signed in. A sign-in that cannot finish
   * — turned down, expired, or used twice — lands on `/sign-in-failed` instead.
   */
  signInUrl(returnTo: string, appearance: Appearance): string {
    return `/api/auth/login?${new URLSearchParams({ returnTo, ...appearanceParams(appearance) })}`;
  },

  /**
   * `GET /api/auth/logout` — navigate here (full page) to sign out.
   *
   * The member server asks to confirm, signs the member out of every service,
   * and ends on its own signed-out page.
   */
  signOutUrl: '/api/auth/logout',

  /**
   * `GET /api/auth/me`
   *
   * The signed-in user.
   * - Returns `null` when signed out (the server's 401 `UNAUTHORIZED`).
   */
  async me(): Promise<User | null> {
    try {
      return await apiFetch<User>('/api/auth/me');
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'UNAUTHORIZED') return null;
      throw error;
    }
  },
};

export const sitemapApi = {
  /**
   * `GET /sitemap.json`
   *
   * The service directory rendered by the footer's "Other Services" column.
   * Served straight from `public/sitemap.json`, so the list changes with a
   * data edit — no client code involved.
   * - Errors: 404 `NOT_FOUND` when the file is absent (the footer then just
   *   renders without that column).
   * - Returns: `Sitemap` — `{ services: [{ name, url, description? }] }`
   */
  get(): Promise<Sitemap> {
    return apiFetch('/sitemap.json');
  },
};

/**
 * The testbed control plane, `/testbed/api/*` (docs/testbed/control-plane.md §3).
 *
 * The dashboard calls as a person: it never sends `X-Testbed-Actor`, so while
 * an agent or CI holds the control lease every operation answers 423
 * `LOCKED` (reads stay open). People never take the lease, so `POST/DELETE
 * /lease` are deliberately not here (docs/spec.md §12).
 *
 * Errors: the envelope as everywhere, plus the testbed codes `LOCKED` (423),
 * `LEASE_HELD`/`RUN_ACTIVE`/`CORE_NOT_RUNNING`/`RESTART_REQUIRED` (409) and
 * `CURSOR_STALE` (410) — `ApiRequestError.code` carries them as strings.
 */
export const testbedApi = {
  /** `GET /testbed/api/manifest` — cores, endpoints, actions and their schemas. */
  manifest(): Promise<TestbedManifest> {
    return apiFetch('/testbed/api/manifest');
  },

  /** `GET /testbed/api/status` — cores, the open Run, the lease. */
  status(): Promise<TestbedStatus> {
    return apiFetch('/testbed/api/status');
  },

  /** `GET /testbed/api/cores/:core/config` */
  config(core: string): Promise<Record<string, unknown>> {
    return apiFetch(`/testbed/api/cores/${encodeURIComponent(core)}/config`);
  },

  /**
   * `PATCH /testbed/api/cores/:core/config` — a partial patch (`faults`
   * replaces the whole list). `restart-required`: saved, applies after stop → start.
   * - Errors: 400 `VALIDATION_ERROR` (`details` = issues with paths), 423 `LOCKED`.
   */
  setConfig(
    core: string,
    patch: Record<string, unknown>,
  ): Promise<{ result: 'applied' | 'restart-required'; config: Record<string, unknown> }> {
    return apiFetch(`/testbed/api/cores/${encodeURIComponent(core)}/config`, {
      method: 'PATCH',
      body: patch,
    });
  },

  /** `POST /testbed/api/cores/:core/{start|stop|reset}` — `_all` for every core. */
  operate(core: string, op: 'start' | 'stop' | 'reset'): Promise<{ cores: CoreStatus[] }> {
    return apiFetch(`/testbed/api/cores/${encodeURIComponent(core)}/${op}`, { method: 'POST' });
  },

  /**
   * `POST /testbed/api/cores/:core/actions/:name` — the action's output.
   * - Errors: 400 `VALIDATION_ERROR`, 409 `CORE_NOT_RUNNING`, 423 `LOCKED` (mutating actions).
   */
  invokeAction(core: string, name: string, input: unknown): Promise<unknown> {
    return apiFetch(
      `/testbed/api/cores/${encodeURIComponent(core)}/actions/${encodeURIComponent(name)}`,
      { method: 'POST', body: input ?? {} },
    );
  },

  /**
   * `POST /testbed/api/runs` — 201 with the new Run.
   * - Errors: 409 `RUN_ACTIVE` (details: the open Run) unless `endActive`.
   */
  startRun(input: { label: string; seed?: string; endActive?: boolean }): Promise<RunMeta> {
    return apiFetch('/testbed/api/runs', { method: 'POST', body: input });
  },

  /** `POST /testbed/api/runs/current/end` — the closed Run with its summary. 404 if none is open. */
  endRun(): Promise<RunMeta> {
    return apiFetch('/testbed/api/runs/current/end', { method: 'POST' });
  },

  /** `GET /testbed/api/runs` — newest first. */
  async runs(): Promise<RunMeta[]> {
    return (await apiFetch<{ runs: RunMeta[] }>('/testbed/api/runs')).runs;
  },

  /** `GET /testbed/api/runs/:id` (`current` = the open Run). */
  run(runId: string): Promise<RunMeta> {
    return apiFetch(`/testbed/api/runs/${encodeURIComponent(runId)}`);
  },

  /** `GET /testbed/api/runs/:id/export` — a link (JSONL download), not a call. */
  exportUrl(runId: string): string {
    return `/testbed/api/runs/${encodeURIComponent(runId)}/export`;
  },

  /**
   * `GET /testbed/api/events?…` — matching events after `after`, oldest first,
   * at most `limit` (default 50, max 500). `cursor` continues; `total` counts all matches.
   * - Errors: 410 `CURSOR_STALE` (details.cursor: where to start again).
   */
  events(
    filter: EventFilter,
  ): Promise<{ events: TestbedEvent[]; cursor: string | null; total: number }> {
    return apiFetch('/testbed/api/events', {
      searchParams: { ...filter },
    });
  },

  /** `GET /testbed/api/events/:id` — one event with its payload. 404 once out of the ring buffer. */
  event(id: string): Promise<TestbedEvent> {
    return apiFetch(`/testbed/api/events/${encodeURIComponent(id)}`);
  },

  /** `POST /testbed/api/wait` — waits (≤ 120 s) for `count` matching events. */
  wait(input: {
    filter: EventFilter;
    count?: number;
    timeoutMs?: number;
  }): Promise<{ events: TestbedEvent[]; timedOut: boolean }> {
    return apiFetch('/testbed/api/wait', { method: 'POST', body: input });
  },

  /** `POST /testbed/api/check` — judges the matching events; recorded in the open Run. */
  check(input: {
    filter: EventFilter;
    expect: { count?: string; none?: true };
    label?: string;
  }): Promise<{ pass: boolean; matched: number; sample: EventLine[] }> {
    return apiFetch('/testbed/api/check', { method: 'POST', body: input });
  },
};
