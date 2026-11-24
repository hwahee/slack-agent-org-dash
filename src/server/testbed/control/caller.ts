/**
 * Callers as they are recorded (events, Run meta). A full lease or MCP
 * session id lets its bearer act as the holder, and events and Runs are open
 * to everyone, so only the first 4 characters are kept.
 */
import type { Caller } from '@shared/testbed/events';

export function publicCaller(caller: Caller): Caller {
  return {
    actor: caller.actor,
    ...(caller.name === undefined ? {} : { name: caller.name }),
    ...(caller.sessionId === undefined ? {} : { sessionId: caller.sessionId.slice(0, 4) }),
    ...(caller.leaseId === undefined ? {} : { leaseId: caller.leaseId.slice(0, 4) }),
  };
}
