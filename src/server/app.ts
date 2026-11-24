/**
 * Assembles the HTTP surface (API routes) as plain data, separate from
 * `Bun.serve` so integration tests can boot the exact same app on an
 * ephemeral port. The static client routes are added only by the real
 * entrypoint (src/server/index.ts).
 */
import type { Container } from './container';
import type { HttpDeps } from './http/respond';
import { apiFallbackRoutes } from './routes/api-fallback';
import { authRoutes } from './routes/auth';
import { livenessRoute, readinessRoute, type AppState } from './routes/health';
import { sitemapRoute } from './routes/sitemap';
import { testbedRoutes, type TestbedHttp, type TestbedSocketData } from './testbed/http/routes';

/** What each socket carries — only testbed dashboard sockets for now. */
export type SocketData = TestbedSocketData;

/** `testbed` is the control plane mounted under `/testbed/*`. */
export function buildApp(container: Container, state: AppState, testbed: TestbedHttp) {
  const deps: HttpDeps = { config: container.config, log: container.log };

  return {
    routes: {
      '/api/health/live': livenessRoute(),
      '/api/health/ready': readinessRoute(container, state),
      ...(container.config.authDriver === 'oidc' ? authRoutes(container, deps) : {}),
      /** Unknown API paths/methods → JSON 404, never the SPA's index.html. */
      '/api/*': apiFallbackRoutes(deps),
      /**
       * Public service directory (NOT the crawler's sitemap.xml). Lives
       * outside /api because it is a static, cacheable document rather than
       * part of the application API.
       */
      '/sitemap.json': sitemapRoute(deps),
      ...testbedRoutes(testbed, deps),
    },

    websocket: {
      open(ws: Bun.ServerWebSocket<SocketData>) {
        testbed.hub.open(ws);
      },
      message() {
        // The dashboard operates over REST; nothing is accepted over WS.
      },
      close(ws: Bun.ServerWebSocket<SocketData>) {
        testbed.hub.close(ws);
      },
    },

    /** Fallback for anything no route matched (API-only mode, e.g. tests). */
    fetch: () => new Response('Not Found', { status: 404 }),
  };
}
