/**
 * REST adapter — `/testbed/api/*` (docs/testbed/control-plane.md §3).
 *
 * Each route resolves the caller, validates its input and calls one control
 * service function. Errors use the boilerplate envelope; the testbed's own
 * codes (`LOCKED`, `LEASE_HELD`, …) get their status from
 * `TESTBED_ERROR_STATUS`, everything else goes through `apiRoute`'s mapping.
 */
import { TESTBED_ERROR_STATUS } from '@shared/testbed/errors';
import { eventFilterValidator, type Caller, type EventFilter } from '@shared/testbed/events';

import { NotFoundError } from '../../lib/errors';
import { apiRoute, json, type ApiHandler, type HttpDeps } from '../../http/respond';
import { TestbedError } from '../errors';
import { checkInput, configPatchInput, startRunInput, waitInput } from '../control/inputs';
import type { ControlService } from '../control/service';
import { resolveCaller, type ControlAuth } from './auth';

const OPERATIONS = ['start', 'stop', 'reset'] as const;

/** The JSON body, or `{}` when there is none. */
async function body(req: Request): Promise<unknown> {
  const text = await req.text();
  return text.trim() === '' ? {} : (JSON.parse(text) as unknown);
}

/** Query string → filter. `limit` is the only number. */
function filterFromQuery(url: URL): EventFilter {
  const raw: Record<string, unknown> = Object.fromEntries(url.searchParams);
  if (typeof raw.limit === 'string') raw.limit = Number(raw.limit);
  delete raw.lang;
  return eventFilterValidator.parse(raw);
}

/**
 * Lets a route's requests outlive `Bun.serve`'s idle timeout (10 s by
 * default) — for `/wait`, which may say nothing for up to 120 s.
 */
function untimed<P extends string>(
  entry: Record<string, (req: Bun.BunRequest<P>) => Promise<Response>>,
): Record<string, (req: Bun.BunRequest<P>, server: Bun.Server<unknown>) => Promise<Response>> {
  return Object.fromEntries(
    Object.entries(entry).map(([method, handler]) => [
      method,
      (req: Bun.BunRequest<P>, server: Bun.Server<unknown>) => {
        server.timeout(req, 0);
        return handler(req);
      },
    ]),
  );
}

type Handler<P extends string> = (req: Bun.BunRequest<P>, caller: Caller) => Promise<Response>;

export function testbedRestRoutes(control: ControlService, deps: HttpDeps, auth: ControlAuth) {
  /** Caller resolution + testbed error codes, inside the shared middleware. */
  const handle =
    <P extends string>(handler: Handler<P>): ApiHandler<P> =>
    async (req) => {
      try {
        return await handler(req, resolveCaller(req, auth));
      } catch (error) {
        if (!(error instanceof TestbedError)) throw error;
        return json(
          {
            error: {
              code: error.code,
              message: error.message,
              ...(error.details === undefined ? {} : { details: error.details }),
            },
          },
          { status: TESTBED_ERROR_STATUS[error.code] },
        );
      }
    };
  const route = <P extends string>(
    handlers: Partial<Record<'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', Handler<P>>>,
  ) =>
    apiRoute<P>(
      Object.fromEntries(
        Object.entries(handlers).map(([method, handler]) => [method, handle(handler)]),
      ),
      deps,
    );

  const notFound: Handler<'/testbed/api/*'> = (req) =>
    Promise.reject(new NotFoundError('route', `${req.method} ${new URL(req.url).pathname}`));

  return {
    '/testbed/api/manifest': route({
      GET: (_req, caller) => Promise.resolve(json(control.getManifest(caller))),
    }),
    '/testbed/api/status': route({
      GET: (_req, caller) => Promise.resolve(json(control.getStatus(caller))),
    }),
    '/testbed/api/cores/:core/config': route<'/testbed/api/cores/:core/config'>({
      GET: (req, caller) => Promise.resolve(json(control.getConfig(req.params.core, caller))),
      PATCH: async (req, caller) =>
        json(
          await control.setConfig(req.params.core, configPatchInput.parse(await body(req)), caller),
        ),
    }),
    '/testbed/api/cores/:core/:op': route<'/testbed/api/cores/:core/:op'>({
      POST: async (req, caller) => {
        const op = OPERATIONS.find((name) => name === req.params.op);
        if (!op) throw new NotFoundError('route', `POST ${new URL(req.url).pathname}`);
        return json({ cores: await control[op](req.params.core, caller) });
      },
    }),
    '/testbed/api/cores/:core/actions/:name': route<'/testbed/api/cores/:core/actions/:name'>({
      POST: async (req, caller) =>
        json(await control.invokeAction(req.params.core, req.params.name, await body(req), caller)),
    }),
    '/testbed/api/runs': route({
      GET: async (_req, caller) => json({ runs: await control.listRuns(caller) }),
      POST: async (req, caller) => {
        const input = startRunInput.parse(await body(req));
        return json(
          await control.startRun(
            {
              label: input.label,
              ...(input.seed === undefined ? {} : { seed: input.seed }),
              ...(input.configOverrides === undefined
                ? {}
                : { configOverrides: input.configOverrides }),
              ...(input.endActive === undefined ? {} : { endActive: input.endActive }),
            },
            caller,
          ),
          { status: 201 },
        );
      },
    }),
    '/testbed/api/runs/current/end': route({
      POST: async (_req, caller) => json(await control.endRun(caller)),
    }),
    '/testbed/api/runs/:id': route<'/testbed/api/runs/:id'>({
      GET: async (req, caller) => {
        const status = control.getStatus(caller);
        const id = req.params.id === 'current' ? (status.run?.runId ?? 'current') : req.params.id;
        return json(await control.getRun(id, caller));
      },
    }),
    '/testbed/api/runs/:id/export': route<'/testbed/api/runs/:id/export'>({
      GET: async (req, caller) =>
        new Response(await control.exportRun(req.params.id, caller), {
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': `attachment; filename="${req.params.id}.jsonl"`,
          },
        }),
    }),
    '/testbed/api/events': route({
      GET: async (req, caller) =>
        json(await control.queryEvents(filterFromQuery(new URL(req.url)), caller)),
    }),
    '/testbed/api/events/:id': route<'/testbed/api/events/:id'>({
      GET: (req, caller) => Promise.resolve(json(control.getEvent(req.params.id, caller))),
    }),
    '/testbed/api/wait': untimed(
      route({
        POST: async (req, caller) => {
          const input = waitInput.parse(await body(req));
          return json(
            await control.waitFor(
              {
                filter: input.filter,
                ...(input.count === undefined ? {} : { count: input.count }),
                ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
              },
              caller,
            ),
          );
        },
      }),
    ),
    '/testbed/api/check': route({
      POST: async (req, caller) => {
        const input = checkInput.parse(await body(req));
        return json(
          await control.check(
            {
              filter: input.filter,
              expect: input.expect,
              ...(input.label === undefined ? {} : { label: input.label }),
            },
            caller,
          ),
        );
      },
    }),
    '/testbed/api/lease': route({
      POST: (_req, caller) => Promise.resolve(json(control.acquireLease(caller))),
      DELETE: (_req, caller) => Promise.resolve(json(control.releaseLease(caller))),
    }),
    /** Unknown control-plane paths → JSON 404, never the SPA. */
    '/testbed/api/*': route({
      GET: notFound,
      POST: notFound,
      PATCH: notFound,
      PUT: notFound,
      DELETE: notFound,
    }),
  };
}
