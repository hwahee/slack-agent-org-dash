/**
 * Everything the testbed mounts on the HTTP server: REST, the WS upgrade and
 * the local-only emergency lease release used by `bun run testbed:release`.
 */
import { json, type HttpDeps } from '../../http/respond';
import type { ControlService } from '../control/service';
import { humanCaller, type ControlAuth } from './auth';
import { testbedRestRoutes } from './rest';
import type { TestbedSocketHub } from './ws';

const RELEASE_PATH = '/testbed/internal/release';

export interface TestbedHttp {
  control: ControlService;
  hub: TestbedSocketHub;
  auth: ControlAuth;
}

/** What a testbed WebSocket carries. */
export interface TestbedSocketData {
  kind: 'testbed';
}

function isLoopback(address: string | undefined): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    (address?.startsWith('127.') ?? false)
  );
}

export function testbedRoutes(testbed: TestbedHttp, deps: HttpDeps) {
  return {
    ...testbedRestRoutes(testbed.control, deps, testbed.auth),
    /** Dashboard stream (signed-in people only when sign-in is on). */
    '/testbed/ws': (req: Request, server: Bun.Server<TestbedSocketData>) => {
      try {
        humanCaller(req, testbed.auth);
      } catch {
        return new Response('Unauthorized', { status: 401 });
      }
      return server.upgrade(req, { data: { kind: 'testbed' } })
        ? undefined
        : new Response('WebSocket upgrade required', { status: 426 });
    },
    /**
     * Forced lease release — only from this machine, never through a proxy
     * (docs/testbed/control-plane.md §2: the emergency exit besides the TTL).
     */
    [RELEASE_PATH]: {
      POST: (req: Request, server: Bun.Server<TestbedSocketData>) => {
        const address = server.requestIP(req)?.address;
        if (!isLoopback(address) || req.headers.has('x-forwarded-for')) {
          return json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 });
        }
        return json({ released: testbed.control.lease.forceRelease() });
      },
    },
  };
}
