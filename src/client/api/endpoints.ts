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
