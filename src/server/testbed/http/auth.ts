/**
 * Who is calling the control plane (docs/testbed/control-plane.md §7).
 *
 * - With `TESTBED_CONTROL_TOKEN` set, agents and CI must send
 *   `Authorization: Bearer <token>`; a valid token makes the caller the actor
 *   it names in `X-Testbed-Actor` (`agent` or `ci`, default `ci`).
 * - Without a token (local), `X-Testbed-Actor` is taken at its word; no
 *   header means `human`. A development tool, so self-reporting is allowed.
 * - A `human` needs a signed-in session when people sign in (`AUTH_DRIVER=oidc`).
 * - `X-Testbed-Lease` carries the REST lease id.
 */
import { timingSafeEqual } from 'node:crypto';

import type { Caller } from '@shared/testbed/events';

import { readCaller } from '../../auth/session';
import type { ServerConfig } from '../../config';
import { UnauthorizedError } from '../../lib/errors';

const ACTOR_HEADER = 'x-testbed-actor';
const LEASE_HEADER = 'x-testbed-lease';

export interface ControlAuth {
  controlToken?: string;
  server: Pick<ServerConfig, 'authDriver' | 'oidc'>;
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/** The signed-in person, or 401 when sign-in is on and nobody is signed in. */
export function humanCaller(req: Request, auth: ControlAuth): Caller {
  const person = readCaller(req, auth.server);
  if (person.kind === 'guest') throw new UnauthorizedError();
  return person.kind === 'member'
    ? { actor: 'human', name: person.displayName }
    : { actor: 'human' };
}

/**
 * MCP: with `TESTBED_CONTROL_TOKEN` set, every request needs the Bearer token.
 * Without one (local), anything goes; the caller is an agent either way.
 */
export function controlTokenOk(req: Request, auth: ControlAuth): boolean {
  if (auth.controlToken === undefined) return true;
  const bearer = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  return bearer !== undefined && sameToken(bearer, auth.controlToken);
}

export function resolveCaller(req: Request, auth: ControlAuth): Caller {
  const claimed = req.headers.get(ACTOR_HEADER)?.toLowerCase();
  const leaseId = req.headers.get(LEASE_HEADER) ?? undefined;
  const machine = claimed === 'agent' || claimed === 'ci' ? claimed : undefined;
  const withLease = (caller: Caller): Caller =>
    leaseId === undefined ? caller : { ...caller, leaseId };

  if (auth.controlToken !== undefined) {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (bearer !== undefined) {
      if (!sameToken(bearer, auth.controlToken)) throw new UnauthorizedError();
      return withLease({ actor: machine ?? 'ci' });
    }
    if (machine) throw new UnauthorizedError();
    return withLease(humanCaller(req, auth));
  }
  return withLease(machine ? { actor: machine } : humanCaller(req, auth));
}
