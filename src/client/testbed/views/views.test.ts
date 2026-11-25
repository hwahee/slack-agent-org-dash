/**
 * The dashboard views' logic (docs/spec.md §11 M9): virtual scrolling, the
 * filter in the address, following, statistics, redacted values and the
 * agent timeline.
 */
import { describe, expect, test } from 'bun:test';

import type { TestbedEvent } from '@shared/testbed/events';
import type { UtcIsoString } from '@shared/time';

import { callerLabel, isAgentTimelineEvent, isRedacted, localTime } from './event-display';
import { filterFromParams, filterToParams } from './log-filter';
import { computeStats, eventsPerSecond, percentile } from './stats';
import { atBottom, visibleRange } from './virtual';

let seq = 0;
function event(fields: Partial<TestbedEvent> = {}): TestbedEvent {
  const n = seq++;
  return {
    seq: n,
    id: `boot:${n}`,
    ts: '2026-11-24T00:00:00.000Z' as UtcIsoString,
    runId: null,
    core: 'sample',
    kind: 'sample.data.echoed',
    level: 'info',
    actor: 'product',
    summary: `event ${n}`,
    payload: {},
    ...fields,
  };
}

describe('visibleRange', () => {
  test('the rows in view plus 20 above and below', () => {
    expect(
      visibleRange({ scrollTop: 2800, viewportHeight: 280, rowHeight: 28, count: 1000 }),
    ).toEqual({ start: 80, end: 131 });
  });

  test('clamped at the top and the bottom', () => {
    expect(visibleRange({ scrollTop: 0, viewportHeight: 280, rowHeight: 28, count: 1000 })).toEqual(
      {
        start: 0,
        end: 31,
      },
    );
    expect(
      visibleRange({ scrollTop: 27_720, viewportHeight: 280, rowHeight: 28, count: 1000 }),
    ).toEqual({ start: 970, end: 1000 });
    expect(visibleRange({ scrollTop: 0, viewportHeight: 280, rowHeight: 28, count: 0 })).toEqual({
      start: 0,
      end: 0,
    });
    expect(visibleRange({ scrollTop: 0, viewportHeight: 280, rowHeight: 28, count: 5 })).toEqual({
      start: 0,
      end: 5,
    });
  });
});

describe('following new events', () => {
  test('follows at the bottom (within half a row), stops once scrolled up', () => {
    const base = { viewportHeight: 280, scrollHeight: 2800, rowHeight: 28 };
    expect(atBottom({ ...base, scrollTop: 2520 })).toBe(true);
    expect(atBottom({ ...base, scrollTop: 2507 })).toBe(true);
    expect(atBottom({ ...base, scrollTop: 2505 })).toBe(false);
    expect(atBottom({ ...base, scrollTop: 0 })).toBe(false);
  });
});

describe('filter ↔ address', () => {
  test('round trip, keeping other parameters', () => {
    const filter = {
      run: 'run-3-ab12',
      core: 'sample',
      kind: 'sample.data',
      level: 'warn' as const,
      actor: 'agent' as const,
      text: 'c-3',
    };
    const params = filterToParams(filter, new URLSearchParams('tab=events'));
    expect(params.toString()).toBe(
      'tab=events&core=sample&kind=sample.data&level=warn&actor=agent&run=run-3-ab12&q=c-3',
    );
    expect(filterFromParams(params)).toEqual(filter);
  });

  test('defaults: run=current, empty fields and unknown values left out', () => {
    expect(filterFromParams(new URLSearchParams('level=loud&actor=robot&core='))).toEqual({
      run: 'current',
    });
    expect(
      filterToParams(
        { run: 'current', core: '' },
        new URLSearchParams('run=all&core=x'),
      ).toString(),
    ).toBe('');
  });
});

describe('computeStats', () => {
  test('counts, error rate and latency with p95 on fixed input', () => {
    const latencies = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200
    const events = [
      ...latencies.map((latencyMs) => event({ kind: 'sample.data.echoed', latencyMs })),
      event({ kind: 'sample.connection.opened' }),
      event({ kind: 'sample.connection.opened' }),
      event({ kind: 'sample.data.too-large', level: 'warn' }),
      event({ kind: 'llm.call.failed', level: 'error' }),
      event({ kind: 'llm.call.failed', level: 'error' }),
    ];
    const stats = computeStats(events);
    expect(stats.total).toBe(25);
    expect(stats.byKind).toEqual([
      { kind: 'sample.data.echoed', count: 20 },
      { kind: 'llm.call.failed', count: 2 },
      { kind: 'sample.connection.opened', count: 2 },
      { kind: 'sample.data.too-large', count: 1 },
    ]);
    expect(stats.byLevel).toEqual({ debug: 0, info: 22, warn: 1, error: 2 });
    expect(stats.errorRate).toBe(0.08);
    expect(stats.latency).toEqual([
      { kind: 'sample.data.echoed', count: 20, mean: 105, p95: 190, max: 200 },
    ]);
  });

  test('percentile is nearest-rank; no events is all zeros', () => {
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([], 95)).toBe(0);
    expect(computeStats([])).toMatchObject({ total: 0, errorRate: 0, latency: [] });
  });

  test('events per second over the last 60 s', () => {
    const now = Date.parse('2026-11-24T00:01:00.500Z');
    const at = (iso: string) => event({ ts: iso as UtcIsoString });
    const buckets = eventsPerSecond(
      [
        at('2025-01-01T00:00:00.000Z'), // too old
        at('2026-11-24T00:00:01.100Z'),
        at('2026-11-24T00:00:59.900Z'),
        at('2026-11-24T00:01:00.100Z'),
        at('2026-11-24T00:01:00.200Z'),
      ],
      now,
    );
    expect(buckets).toHaveLength(60);
    expect(buckets[0]).toBe(1); // 00:00:01
    expect(buckets[58]).toBe(1); // 00:00:59
    expect(buckets[59]).toBe(2); // 00:01:00
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(4);
  });
});

describe('event display', () => {
  test('redacted values are the common masking format', () => {
    expect(isRedacted('sk-a…(len 51, sha256:3f9a0c1d22be)')).toBe(true);
    expect(isRedacted('Bear…(len 23, sha256:0123456789ab)')).toBe(true);
    expect(isRedacted('sk-abcdef')).toBe(false);
    expect(isRedacted('…(len 5, sha256:xyz)')).toBe(false);
    expect(isRedacted(42)).toBe(false);
  });

  test('the agent timeline: agent events, control calls and lease changes, not people', () => {
    const kept = [
      event({ actor: 'agent', kind: 'sample.broadcast.sent' }),
      event({ actor: 'agent', kind: 'testbed.check.evaluated' }),
      event({ actor: 'agent', kind: 'testbed.control.invoked' }),
      event({ actor: 'ci', kind: 'testbed.control.invoked' }),
      event({ actor: 'system', kind: 'testbed.lease.expired' }),
      event({ actor: 'ci', kind: 'testbed.lease.acquired' }),
    ];
    const dropped = [
      event({ actor: 'product', kind: 'sample.data.echoed' }),
      event({ actor: 'system', kind: 'testbed.core.state' }),
      event({ actor: 'system', kind: 'testbed.run.started' }),
      event({ actor: 'human', kind: 'testbed.controls.changed' }),
      // The person at the dashboard: their clicks are in the event log.
      event({ actor: 'human', kind: 'testbed.control.invoked' }),
      event({ actor: 'human', kind: 'testbed.lease.denied' }),
    ];
    expect([...kept, ...dropped].filter(isAgentTimelineEvent)).toEqual(kept);
  });

  test('caller label: name and the 4-character session or lease id', () => {
    expect(
      callerLabel(
        event({
          kind: 'testbed.control.invoked',
          actor: 'agent',
          payload: { caller: { actor: 'agent', name: 'claude-code', sessionId: 'ab12' } },
        }),
      ),
    ).toBe('claude-code · ab12');
    expect(
      callerLabel(
        event({
          kind: 'testbed.lease.acquired',
          actor: 'ci',
          payload: { lease: { actor: 'ci', holder: '9f3c', expiresAt: '', remainingMs: 0 } },
        }),
      ),
    ).toBe('ci · 9f3c');
    // Agent events past the control call carry the caller in the envelope.
    expect(
      callerLabel(
        event({
          kind: 'sample.broadcast.sent',
          actor: 'agent',
          caller: { actor: 'agent', name: 'qa-claude', sessionId: '074a' },
        }),
      ),
    ).toBe('qa-claude · 074a');
    expect(
      callerLabel(
        event({
          kind: 'testbed.check.evaluated',
          actor: 'agent',
          caller: { actor: 'agent', leaseId: '9f3c' },
        }),
      ),
    ).toBe('agent · 9f3c');
    expect(callerLabel(event({ actor: 'agent', kind: 'sample.broadcast.sent' }))).toBe('agent');
  });

  test('local time has milliseconds', () => {
    expect(localTime('2026-11-24T00:00:00.007Z')).toMatch(/^\d\d:\d\d:\d\d\.007$/);
  });
});
