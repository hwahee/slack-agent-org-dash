import { describe, expect, test } from 'bun:test';

import type { CoreState, CoreStatus, ReplicaStatus } from '@shared/testbed/core';

import { applicableOps } from './core-ops';

function replica(id: string, state: CoreState): ReplicaStatus {
  return { id, state, restarts: 0, counters: {}, endpoints: [] };
}

function external(states: CoreState[], overall: CoreState): CoreStatus {
  return {
    id: 'py',
    kind: 'passive',
    title: 'py',
    state: overall,
    endpoints: [],
    counters: {},
    external: true,
    replicas: states.map((state, index) => replica(`r${index}`, state)),
  };
}

describe('applicableOps', () => {
  test.each<[CoreState, boolean, boolean]>([
    ['idle', true, false],
    ['starting', false, false],
    ['running', false, true],
    ['stopping', false, false],
    ['stopped', true, false],
    ['error', true, false],
  ])('in-proc %s: start %p, stop %p, reset always', (state, start, stop) => {
    expect(applicableOps(state, undefined)).toEqual({ start, stop, reset: true });
  });

  test('external: judged by the replicas, not the summed-up state', () => {
    // One replica down, one running: the overall state is `stopped`, yet both apply.
    expect(applicableOps('stopped', external(['stopped', 'running'], 'stopped'))).toEqual({
      start: true,
      stop: true,
      reset: true,
    });
    expect(applicableOps('running', external(['running', 'running'], 'running'))).toEqual({
      start: false,
      stop: true,
      reset: true,
    });
    expect(applicableOps('error', external(['error', 'stopped'], 'error'))).toEqual({
      start: true,
      stop: false,
      reset: true,
    });
  });

  test('external with no replicas reported yet: falls back to the overall state', () => {
    expect(applicableOps('idle', external([], 'idle'))).toEqual({
      start: true,
      stop: false,
      reset: true,
    });
  });
});
