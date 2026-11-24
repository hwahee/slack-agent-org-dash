/**
 * API integration tests: the real app (routes, middleware, container)
 * booted on an ephemeral port with the in-memory persistence
 * driver — one command, zero external services.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { VERSION_HEADER } from '@shared/api/version';
import type { Sitemap } from '@shared/domain/sitemap';
import type { User } from '@shared/domain/user';

import { buildApp } from '../app';
import { memberCookie as signedInCookie, startFakeIssuer } from '../auth/fake-issuer';
import { loadServerConfig, type ServerConfig } from '../config';
import { createContainer, type Container } from '../container';
import { silentLogger } from '../lib/log';
import type { AppState } from '../routes/health';
import type { TestbedSocketData } from '../testbed/http/routes';
import { createTestControlPlane } from '../testbed/testing';

const ALLOWED_ORIGIN = 'https://allowed.example.com';

/** The member server, standing in: signs members in and says who they are. */
const issuer = startFakeIssuer();
let config: ServerConfig;
let container: Container;
let state: AppState;
let server: Bun.Server<TestbedSocketData>;
let plane: Awaited<ReturnType<typeof createTestControlPlane>>['plane'];
let baseUrl: string;
/** Session cookie of a signed-in member — `/api/auth/me` answers 200 with it. */
let memberCookie: string;

beforeAll(async () => {
  ({ plane } = await createTestControlPlane());
  config = issuer.config({
    APP_ENV: 'local',
    PUBSUB_DRIVER: 'memory',
    CORS_ORIGINS: ALLOWED_ORIGIN,
  });
  container = createContainer(config, { log: silentLogger });
  state = { shuttingDown: false };
  const app = buildApp(container, state, plane);
  server = Bun.serve({ port: 0, ...app });
  baseUrl = String(server.url).replace(/\/$/, '');
  memberCookie = signedInCookie(config, { userId: 'tester', displayName: 'Tester' });
});

afterAll(async () => {
  plane.dispose();
  await server.stop(true);
  await container.dispose();
  await issuer.stop();
});

beforeEach(() => {
  state.shuttingDown = false;
});

/**
 * Calls the API as the signed-in member by default; `as: 'guest'` sends no
 * session. An explicit `cookie` header wins over either.
 */
async function api<T = unknown>(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; as?: 'member' | 'guest' } = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(baseUrl + path, {
    method,
    redirect: 'manual', // the sign-in routes answer with redirects to check
    headers: {
      ...((options.as ?? 'member') === 'member' ? { cookie: memberCookie } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false;
  return {
    status: response.status,
    body: (isJson && text ? JSON.parse(text) : undefined) as T,
    headers: response.headers,
  };
}

describe('health endpoints', () => {
  test('liveness reports ok + version', async () => {
    const { status, body } = await api<{ status: string; version: string }>(
      'GET',
      '/api/health/live',
    );
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('dev');
  });

  test('readiness reports db state', async () => {
    const { status, body } = await api<{ ready: boolean; db: string }>('GET', '/api/health/ready');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ready: true, db: 'up' });
  });

  test('readiness turns 503 while shutting down (LB drain)', async () => {
    state.shuttingDown = true;
    const { status, body } = await api<{ ready: boolean }>('GET', '/api/health/ready');
    expect(status).toBe(503);
    expect(body.ready).toBe(false);
  });
});

describe('error envelope', () => {
  test('localizes error messages from Accept-Language and ?lang', async () => {
    const korean = await api<{ error: { message: string } }>('GET', '/api/none', {
      headers: { 'accept-language': 'ko-KR,ko;q=0.9' },
    });
    expect(korean.body.error.message).toBe('요청한 리소스를 찾을 수 없습니다.');

    const override = await api<{ error: { message: string } }>('GET', '/api/none?lang=ko');
    expect(override.body.error.message).toBe('요청한 리소스를 찾을 수 없습니다.');
  });
});

describe('deployment-version handshake', () => {
  test('matching version passes', async () => {
    const { status } = await api('GET', '/api/auth/me', {
      headers: { [VERSION_HEADER]: 'dev' },
    });
    expect(status).toBe(200);
  });

  test('mismatched version is rejected with 409 VERSION_MISMATCH', async () => {
    const { status, body } = await api<{ error: { code: string } }>('GET', '/api/auth/me', {
      headers: { [VERSION_HEADER]: 'other-build' },
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe('VERSION_MISMATCH');
  });

  test('requests without the header (curl, probes) are unaffected', async () => {
    expect((await api('GET', '/api/auth/me')).status).toBe(200);
  });
});

describe('CORS', () => {
  test('preflight from an allowed origin succeeds', async () => {
    const { status, headers } = await api('OPTIONS', '/api/auth/me', {
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(status).toBe(204);
    expect(headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(headers.get('access-control-allow-headers')).toContain(VERSION_HEADER);
  });

  test('preflight from a disallowed origin is denied', async () => {
    const { status, headers } = await api('OPTIONS', '/api/auth/me', {
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    });
    expect(status).toBe(403);
    expect(headers.get('access-control-allow-origin')).toBeNull();
  });

  test('actual responses carry CORS headers only for allowed origins', async () => {
    const allowed = await api('GET', '/api/auth/me', { headers: { origin: ALLOWED_ORIGIN } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);

    const denied = await api('GET', '/api/auth/me', {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('sitemap', () => {
  test('serves the service directory from public/sitemap.json', async () => {
    const { status, body, headers } = await api<Sitemap>('GET', '/sitemap.json');
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toContain('max-age');
    // The shipped file is sample data — assert the shape, not its entries.
    expect(Array.isArray(body.services)).toBe(true);
    for (const service of body.services) {
      expect(service.name.length).toBeGreaterThan(0);
      expect(service.url).toMatch(/^(https?:\/\/|\/)/);
    }
  });
});

describe('fallback', () => {
  test('unknown paths return 404', async () => {
    expect((await api('GET', '/definitely-not-a-route')).status).toBe(404);
  });

  test('unknown API paths return the JSON 404 envelope, not the SPA', async () => {
    const { status, body } = await api<{ error: { code: string; message: string } }>(
      'GET',
      '/api/definitely-not-a-route?lang=ko',
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('요청한 리소스를 찾을 수 없습니다.');
  });

  test('a method a known API path does not define also gets the JSON 404 envelope', async () => {
    const { status, body } = await api<{ error: { code: string } }>('PUT', '/api/auth/me');
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

/** The `name=value` pair of the cookie `name` a response sets, ready to send back. */
function cookieFrom(headers: Headers, name: string): string | undefined {
  return headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .find((pair) => pair.startsWith(`${name}=`));
}

const SESSION = 'session-test-service';
const SIGN_IN = 'sign-in-test-service';

describe('auth (AUTH_DRIVER=oidc)', () => {
  /** Starts a sign-in the way a browser does; returns what comes back to the callback. */
  async function startSignIn(returnTo: string, appearance: Record<string, string> = {}) {
    const query = new URLSearchParams({ returnTo, ...appearance });
    const login = await api('GET', `/api/auth/login?${query}`, { as: 'guest' });
    const location = new URL(login.headers.get('location') ?? '');
    return {
      login,
      location,
      cookie: cookieFrom(login.headers, SIGN_IN) ?? '',
      state: location.searchParams.get('state') ?? '',
    };
  }

  /** The member server's answer to a sign-in, as the browser brings it back. */
  const callback = (query: string, cookie: string) =>
    api('GET', `/api/auth/callback?${query}`, { headers: { cookie } });

  test('login → the member server → callback: signed in, back where it started', async () => {
    const { login, location, cookie, state } = await startSignIn('/design-system?page=2');
    expect(login.status).toBe(302);
    expect(location.origin + location.pathname).toBe(`${issuer.url}/oauth2/auth`);
    expect(location.searchParams.get('client_id')).toBe('test-service');
    expect(login.headers.getSetCookie()[0]).toContain('HttpOnly');

    const code = issuer.issueCode({ sub: 'alice', name: 'Alice', sid: 'sid-a' });
    const back = await callback(`code=${code}&state=${state}`, cookie);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/design-system?page=2');
    expect(cookieFrom(back.headers, SIGN_IN)).toBe(`${SIGN_IN}=`); // used up
    const session = cookieFrom(back.headers, SESSION) ?? '';

    const me = await api<User>('GET', '/api/auth/me', { headers: { cookie: session } });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ id: 'alice', displayName: 'Alice' });
  });

  test("the member server's sign-in page is asked to look like the page it started on", async () => {
    const { location } = await startSignIn('/', {
      theme: 'dark',
      design: 'office',
      ui_locales: 'ko',
    });
    expect(location.searchParams.get('theme')).toBe('dark');
    expect(location.searchParams.get('design')).toBe('office');
    expect(location.searchParams.get('ui_locales')).toBe('ko');

    // Unknown values are dropped, not passed through.
    const odd = await startSignIn('/', { theme: 'sepia', design: '<x>', ui_locales: 'fr' });
    expect(odd.location.searchParams.has('theme')).toBe(false);
    expect(odd.location.searchParams.has('design')).toBe(false);
    expect(odd.location.searchParams.has('ui_locales')).toBe(false);
  });

  test('a sign-in that cannot finish lands on /sign-in-failed and signs nobody in', async () => {
    const turnedDown = await startSignIn('/');
    const notStartedHere = await startSignIn('/');
    const first = await startSignIn('/');
    const second = await startSignIn('/');
    const code = issuer.issueCode({ sub: 'alice' });
    await callback(`code=${code}&state=${first.state}`, first.cookie);

    for (const answer of [
      await callback(`error=access_denied&state=${turnedDown.state}`, turnedDown.cookie),
      // Another browser's sign-in (no sign-in cookie here), or a state that does not match.
      await callback(
        `code=${issuer.issueCode({ sub: 'mallory' })}&state=${notStartedHere.state}`,
        '',
      ),
      await callback(
        `code=${issuer.issueCode({ sub: 'mallory' })}&state=wrong`,
        notStartedHere.cookie,
      ),
      // The same answer brought back twice (the back button).
      await callback(`code=${code}&state=${second.state}`, second.cookie),
    ]) {
      expect(answer.status).toBe(302);
      expect(answer.headers.get('location')).toBe('/sign-in-failed');
      expect(cookieFrom(answer.headers, SESSION)).toBeUndefined();
    }
  });

  test('a sign-in only ever comes back to a page on this site', async () => {
    for (const returnTo of [
      'https://elsewhere.test/',
      '//elsewhere.test/',
      '/\\elsewhere.test',
      '/\t/elsewhere.test',
    ]) {
      const { cookie, state } = await startSignIn(returnTo);
      const back = await callback(
        `code=${issuer.issueCode({ sub: 'alice' })}&state=${state}`,
        cookie,
      );
      expect(back.headers.get('location')).toBe('/');
    }
  });

  test('me without a session, or with one this service did not sign, is 401', async () => {
    const { status, body } = await api<{ error: { code: string; message: string } }>(
      'GET',
      '/api/auth/me?lang=ko',
      { as: 'guest' },
    );
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
    const forged = `${SESSION}=${Buffer.from('{"userId":"ghost"}').toString('base64url')}.x`;
    expect((await api('GET', '/api/auth/me', { headers: { cookie: forged } })).status).toBe(401);
  });

  test('signing out goes to the member server; its front-channel call ends only the session it names', async () => {
    const logout = await api('GET', '/api/auth/logout');
    expect(logout.status).toBe(302);
    expect(logout.headers.get('location')).toBe(`${issuer.url}/oauth2/sessions/logout`);
    expect(cookieFrom(logout.headers, SESSION)).toBeUndefined(); // the member server confirms first

    const cookie = signedInCookie(config, { userId: 'alice', sid: 'sid-a' });
    const iss = encodeURIComponent(issuer.url);
    const frontChannel = (query: string) =>
      api('GET', `/api/auth/frontchannel-logout?${query}`, { headers: { cookie } });

    const newer = await frontChannel(`iss=${iss}&sid=sid-b`);
    expect(newer.status).toBe(200);
    expect(cookieFrom(newer.headers, SESSION)).toBeUndefined();
    const stranger = await frontChannel(
      `iss=${encodeURIComponent('http://elsewhere.test')}&sid=sid-a`,
    );
    expect(cookieFrom(stranger.headers, SESSION)).toBeUndefined();

    const named = await frontChannel(`iss=${iss}&sid=sid-a`);
    expect(cookieFrom(named.headers, SESSION)).toBe(`${SESSION}=`);
  });

  test('with AUTH_DRIVER=none the auth routes are not mounted', () => {
    const none = loadServerConfig({ DB_DRIVER: 'memory', AUTH_DRIVER: 'none' });
    const app = buildApp(createContainer(none, { log: silentLogger }), state, plane);
    expect(Object.keys(app.routes).filter((path) => path.startsWith('/api/auth'))).toEqual([]);
  });
});
