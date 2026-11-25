/**
 * The event log's filter and the address (docs/testbed/dashboard.md §1):
 * every field lives in the query string, so a link opens the same view.
 */
import {
  matchesFilter,
  type Actor,
  type EventLevel,
  type TestbedEvent,
} from '@shared/testbed/events';

export interface LogFilter {
  core?: string;
  /** Kind prefix. */
  kind?: string;
  /** This level or above. */
  level?: EventLevel;
  actor?: Actor;
  /** An external core's replica (`r0`, `r1`, …). */
  replica?: string;
  /** `current` (default: the open Run, else everything), `all`, or a Run id. */
  run: string;
  /** Substring of `summary`. */
  text?: string;
}

const LEVELS: readonly EventLevel[] = ['debug', 'info', 'warn', 'error'];
const ACTORS: readonly Actor[] = ['product', 'human', 'agent', 'ci', 'system'];

/** Query-string names. `tab` and other keys are left alone. */
const KEYS = {
  core: 'core',
  kind: 'kind',
  level: 'level',
  actor: 'actor',
  replica: 'replica',
  run: 'run',
  text: 'q',
} as const;

export function filterFromParams(params: URLSearchParams): LogFilter {
  const value = (key: string) => {
    const raw = params.get(key);
    return raw === null || raw === '' ? undefined : raw;
  };
  const level = value(KEYS.level);
  const actor = value(KEYS.actor);
  const core = value(KEYS.core);
  const kind = value(KEYS.kind);
  const text = value(KEYS.text);
  const replica = value(KEYS.replica);
  return {
    run: value(KEYS.run) ?? 'current',
    ...(core === undefined ? {} : { core }),
    ...(kind === undefined ? {} : { kind }),
    ...(level !== undefined && (LEVELS as readonly string[]).includes(level)
      ? { level: level as EventLevel }
      : {}),
    ...(actor !== undefined && (ACTORS as readonly string[]).includes(actor)
      ? { actor: actor as Actor }
      : {}),
    ...(replica === undefined ? {} : { replica }),
    ...(text === undefined ? {} : { text }),
  };
}

/** `params` with the filter written into it (empty fields and `run=current` removed). */
export function filterToParams(filter: LogFilter, params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [field, key] of Object.entries(KEYS) as [keyof LogFilter, string][]) {
    const value = filter[field];
    if (value === undefined || value === '' || (field === 'run' && value === 'current')) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  return next;
}

/**
 * The live events the log shows for `filter`: `run=current` is the open Run
 * (everything when none is open), `all` is everything, a Run id that Run.
 */
export function selectLogEvents(
  events: readonly TestbedEvent[],
  filter: LogFilter,
  openRunId: string | null,
): TestbedEvent[] {
  const runId =
    filter.run === 'all'
      ? undefined
      : filter.run === 'current'
        ? (openRunId ?? undefined)
        : filter.run;
  const fields = {
    ...(filter.core === undefined ? {} : { core: filter.core }),
    ...(filter.kind === undefined ? {} : { kind: filter.kind }),
    ...(filter.level === undefined ? {} : { level: filter.level }),
    ...(filter.actor === undefined ? {} : { actor: filter.actor }),
    ...(filter.replica === undefined ? {} : { replica: filter.replica }),
    ...(filter.text === undefined ? {} : { text: filter.text }),
  };
  return events.filter(
    (event) => (runId === undefined || event.runId === runId) && matchesFilter(event, fields),
  );
}
