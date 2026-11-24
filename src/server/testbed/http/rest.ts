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
import { s, toValidator } from '@shared/validation';

import { NotFoundError } from '../../lib/errors';
import { apiRoute, json, type ApiHandler, type HttpDeps } from '../../http/respond';
import { TestbedError } from '../errors';
import type { ControlService } from '../control/service';
import { resolveCaller, type ControlAuth } from './auth';

const startRunValidator = toValidator(
  s.object({
    label: s.string().check(s.minLength(1), s.maxLength(200)),
    seed: s.optional(s.string().check(s.minLength(1), s.maxLength(200))),
    configOverrides: s.optional(s.record(s.string(), s.record(s.string(), s.unknown()))),
    endActive: s.optional(s.boolean()),
  }),
);

const configPatchValidator = toValidator(s.record(s.string(), s.unknown()));

const waitValidator = toValidator(
  s.object({
    filter: s._default(s.unknown(), {}),
    count: s.optional(s.int().check(s.gte(1), s.lte(500))),
    timeoutMs: s.optional(s.int().check(s.gte(0))),
  }),
);

const checkValidator = toValidator(
  s.object({
    filter: s._default(s.unknown(), {}),
    expect: s._default(s.record(s.string(), s.unknown()), {}),
    label: s.optional(s.string().check(s.minLength(1), s.maxLength(200))),
  }),
);

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
          await control.setConfig(
            req.params.core,
            configPatchValidator.parse(await body(req)),
            caller,
          ),
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
        const input = startRunValidator.parse(await body(req));
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
    '/testbed/api/wait': route({
      POST: async (req, caller) => {
        const input = waitValidator.parse(await body(req));
        return json(
          await control.waitFor(
            {
              filter: eventFilterValidator.parse(input.filter),
              ...(input.count === undefined ? {} : { count: input.count }),
              ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
            },
            caller,
          ),
        );
      },
    }),
    '/testbed/api/check': route({
      POST: async (req, caller) => {
        const input = checkValidator.parse(await body(req));
        return json(
          await control.check(
            {
              filter: eventFilterValidator.parse(input.filter),
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
