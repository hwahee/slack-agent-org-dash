/**
 * Builds a Run's summary from its events (docs/testbed/runs-and-checks.md §1.3).
 * Fed event by event while the Run is open, or replayed from a stored Run
 * that a restart left open.
 */
import type { TestbedEvent } from '@shared/testbed/events';
import type { CheckOutcome, RunSummary } from '@shared/testbed/runs';

const TOP_ERRORS = 5;

export class SummaryBuilder {
  private readonly byKind: Record<string, number> = {};
  private readonly byLevel: RunSummary['byLevel'] = { debug: 0, info: 0, warn: 0, error: 0 };
  private readonly errors = new Map<string, { count: number; summary: string }>();
  private readonly checks: CheckOutcome[] = [];

  add(event: TestbedEvent): void {
    this.byKind[event.kind] = (this.byKind[event.kind] ?? 0) + 1;
    this.byLevel[event.level] += 1;
    if (event.level === 'error') {
      const seen = this.errors.get(event.kind);
      if (seen) seen.count += 1;
      else this.errors.set(event.kind, { count: 1, summary: event.summary });
    }
    if (event.kind === 'testbed.check.evaluated') {
      const { label, pass, matched } = event.payload as CheckOutcome;
      this.checks.push({ ...(label === undefined ? {} : { label }), pass, matched });
    }
  }

  build(startedAt: string, endedAt: string): RunSummary {
    return {
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
      byKind: { ...this.byKind },
      byLevel: { ...this.byLevel },
      topErrors: [...this.errors.entries()]
        .map(([kind, { count, summary }]) => ({ kind, count, summary }))
        .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
        .slice(0, TOP_ERRORS),
      checks: [...this.checks],
    };
  }
}
