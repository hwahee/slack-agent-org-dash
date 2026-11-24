/**
 * check — judges whether the events so far meet an expectation
 * (docs/testbed/runs-and-checks.md §2). Not an operation, so no lease.
 */
import type { Caller, EventFilter, TestbedEvent } from '@shared/testbed/events';
import { s, toValidator } from '@shared/validation';

import type { EventBus } from '../events/bus';
import { matchesFilter } from '../events/filter';
import type { RunManager } from './runs';
import type { RunStore } from './store';

const SAMPLE_SIZE = 10;

export interface CheckExpectation {
  /** `'==n'`, `'>=n'` or `'<=n'`. */
  count?: string;
  none?: true;
}

export interface CheckInput {
  filter: EventFilter;
  expect: CheckExpectation;
  label?: string;
}

export interface CheckResult {
  pass: boolean;
  matched: number;
  /** Up to 10 matching events, as their id, kind and summary. */
  sample: { id: string; kind: string; summary: string }[];
}

const expectationValidator = toValidator(
  s
    .object({
      count: s.optional(s.string().check(s.regex(/^(==|>=|<=)\d+$/))),
      none: s.optional(s.literal(true)),
    })
    .check(
      s.refine((value) => !(value.count !== undefined && value.none !== undefined), {
        message: 'Give either count or none, not both',
      }),
    ),
);

function judge(matched: number, expectation: CheckExpectation): boolean {
  if (expectation.none) return matched === 0;
  const [, op, n] = /^(==|>=|<=)(\d+)$/.exec(expectation.count ?? '>=1') ?? [];
  const target = Number(n);
  if (op === '==') return matched === target;
  if (op === '<=') return matched <= target;
  return matched >= target;
}

export interface CheckDeps {
  bus: EventBus;
  runs: RunManager;
  store: RunStore;
}

/**
 * The events a check looks at: a named Run from the store; `'current'` or no
 * `runId` → the open Run; no `runId` and no open Run → the whole ring buffer.
 */
async function targetEvents(deps: CheckDeps, filter: EventFilter): Promise<TestbedEvent[]> {
  const open = deps.runs.active();
  if (filter.runId === undefined && !open) return deps.bus.buffered();
  const runId =
    filter.runId === undefined || filter.runId === 'current' ? open?.runId : filter.runId;
  return runId === undefined ? [] : deps.store.events(runId);
}

export async function runCheck(
  deps: CheckDeps,
  input: CheckInput,
  caller: Caller,
): Promise<CheckResult> {
  const expectation: CheckExpectation = expectationValidator.parse(input.expect);
  const matching = (await targetEvents(deps, input.filter)).filter((event) =>
    matchesFilter(event, input.filter),
  );
  const pass = judge(matching.length, expectation);
  const label = input.label;
  const expected = expectation.none ? 'none' : (expectation.count ?? '>=1');

  deps.bus.emit({
    core: 'testbed',
    kind: 'testbed.check.evaluated',
    level: pass ? 'info' : 'warn',
    actor: caller.actor,
    summary: `check${label === undefined ? '' : ` '${label}'`} ${pass ? 'passed' : 'failed'}: ${matching.length} matched (expected ${expected})`,
    payload: {
      ...(label === undefined ? {} : { label }),
      pass,
      matched: matching.length,
      expect: expectation,
      filter: input.filter,
    },
  });

  return {
    pass,
    matched: matching.length,
    sample: matching.slice(0, SAMPLE_SIZE).map(({ id, kind, summary }) => ({ id, kind, summary })),
  };
}
