/**
 * The statistics tab's numbers (docs/testbed/dashboard.md §1): counts by
 * kind and level, the error rate, and latency (mean, p95, max) for every
 * kind that carries `latencyMs`. Pure, so it is tested on fixed input.
 */
import type { EventLevel, TestbedEvent } from '@shared/testbed/events';

interface LatencyStats {
  kind: string;
  count: number;
  mean: number;
  p95: number;
  max: number;
}

export interface EventStats {
  total: number;
  /** Most frequent first. */
  byKind: { kind: string; count: number }[];
  byLevel: Record<EventLevel, number>;
  /** `error` events / all events (0 when there are none). */
  errorRate: number;
  latency: LatencyStats[];
}

/** Nearest-rank percentile of sorted values. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export function computeStats(events: readonly TestbedEvent[]): EventStats {
  const kinds = new Map<string, number>();
  const byLevel: Record<EventLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  const latencies = new Map<string, number[]>();
  for (const event of events) {
    kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
    byLevel[event.level] += 1;
    if (typeof event.latencyMs === 'number') {
      const list = latencies.get(event.kind) ?? [];
      list.push(event.latencyMs);
      latencies.set(event.kind, list);
    }
  }
  return {
    total: events.length,
    byKind: [...kinds]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    byLevel,
    errorRate: events.length === 0 ? 0 : byLevel.error / events.length,
    latency: [...latencies]
      .map(([kind, values]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
          kind,
          count: sorted.length,
          mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
          p95: percentile(sorted, 95),
          max: sorted.at(-1) ?? 0,
        };
      })
      .sort((a, b) => a.kind.localeCompare(b.kind)),
  };
}

/** Events per second for the `seconds` seconds up to `now` (oldest first). */
export function eventsPerSecond(
  events: readonly TestbedEvent[],
  now: number,
  seconds = 60,
): number[] {
  const buckets = Array.from({ length: seconds }, () => 0);
  const from = Math.floor(now / 1000) - seconds + 1;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    const second = Math.floor(Date.parse(event.ts) / 1000);
    if (second < from) break;
    const slot = second - from;
    if (slot < seconds) buckets[slot] = (buckets[slot] ?? 0) + 1;
  }
  return buckets;
}
