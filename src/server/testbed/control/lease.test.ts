import { describe, expect, test } from 'bun:test';

import type { TestbedError } from '../errors';
import { EventBus } from '../events/bus';
import { waitForEvent } from '../testing';
import { LeaseManager } from './lease';

function setup(ttlSec = 600) {
  const bus = new EventBus();
  const lease = new LeaseManager(bus, { ttlSec });
  const kinds = () =>
    bus
      .buffered()
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith('testbed.lease.'));
  return { bus, lease, kinds };
}

const agent = { actor: 'agent' as const, sessionId: 'sess-aaaa-1111', name: 'Claude Code' };
const otherAgent = { actor: 'agent' as const, sessionId: 'sess-bbbb-2222' };

describe('lease for MCP sessions', () => {
  test("an agent's first operation takes the lease; its reads do not", () => {
    const { lease, kinds } = setup();
    lease.authorize(agent, 'getStatus', false);
    expect(lease.view()).toBeNull();
    lease.authorize(agent, 'start', true);
    expect(lease.view()).toMatchObject({ actor: 'agent', name: 'Claude Code', holder: 'sess' });
    expect(kinds()).toEqual(['testbed.lease.acquired']);
  });

  test('every call by the holder, reads too, pushes the expiry out', async () => {
    const { lease } = setup();
    lease.authorize(agent, 'start', true);
    const first = lease.view()?.expiresAt ?? '';
    await Bun.sleep(5);
    lease.authorize(agent, 'queryEvents', false);
    expect((lease.view()?.expiresAt ?? '') > first).toBe(true);
  });

  test('another session is LEASE_HELD, a person LOCKED; reads stay open', () => {
    const { lease } = setup();
    lease.authorize(agent, 'start', true);
    expect(() => lease.authorize(otherAgent, 'getStatus', false)).not.toThrow();
    const codes = [otherAgent, { actor: 'human' as const }].map((caller) => {
      try {
        lease.authorize(caller, 'stop', true);
        return 'allowed';
      } catch (error) {
        return (error as TestbedError).code;
      }
    });
    expect(codes).toEqual(['LEASE_HELD', 'LOCKED']);
  });

  test('a new session of the same client is told how to free its old session lease', () => {
    const { lease } = setup();
    lease.authorize(agent, 'start', true);
    const denied = (caller: typeof agent | typeof otherAgent) => {
      try {
        lease.authorize(caller, 'stop', true);
        throw new Error('allowed');
      } catch (error) {
        return error as TestbedError;
      }
    };
    const reconnected = denied({ ...agent, sessionId: 'sess-cccc-3333' });
    expect(reconnected.code).toBe('LEASE_HELD');
    expect(reconnected.details).toMatchObject({ sameClient: true });
    expect(reconnected.message).toContain('Claude Code');
    expect(reconnected.message).toContain('bun run testbed:release');
    expect(reconnected.message).toContain('release_control');
    const other = denied(otherAgent);
    expect(other.details).not.toHaveProperty('sameClient');
    expect(other.message).not.toContain('testbed:release');
    expect(lease.view()?.holder).toBe('sess');
  });

  test('ending the MCP session releases its lease', () => {
    const { lease, bus } = setup();
    lease.authorize(agent, 'start', true);
    lease.releaseSession(otherAgent.sessionId);
    expect(lease.view()).not.toBeNull();
    lease.releaseSession(agent.sessionId);
    expect(lease.view()).toBeNull();
    expect(bus.buffered().at(-1)).toMatchObject({
      kind: 'testbed.lease.released',
      payload: { reason: 'session-closed' },
    });
  });

  test('the TTL ends an idle lease with testbed.lease.expired', async () => {
    const { lease, bus } = setup(1);
    lease.authorize(agent, 'start', true);
    const expired = await waitForEvent(bus, (event) => event.kind === 'testbed.lease.expired');
    expect(expired.actor).toBe('system');
    expect(lease.view()).toBeNull();
    lease.dispose();
  });

  test('only the holder releases (others get false, no denial); forceRelease always can', () => {
    const { lease, kinds } = setup();
    lease.acquire({ actor: 'ci' });
    expect(lease.release({ actor: 'ci', leaseId: 'wrong' })).toBe(false);
    expect(lease.release(otherAgent)).toBe(false);
    expect(lease.view()).not.toBeNull();
    expect(kinds()).toEqual(['testbed.lease.acquired']);
    expect(lease.forceRelease()).toBe(true);
    expect(lease.forceRelease()).toBe(false);
    lease.dispose();
  });
});
