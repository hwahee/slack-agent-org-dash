/**
 * The event log tab (docs/testbed/dashboard.md §1): a virtual list with fixed
 * rows (time, level, actor, kind, summary), filters kept in the address,
 * following at the bottom, and the count the server's sampling left out.
 * A past Run is read over REST (`GET /events?runId=…`, page by page).
 */
import { useQuery } from '@tanstack/react-query';
import { ArrowDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { EVENT_LEVELS, type Actor, type TestbedEvent } from '@shared/testbed/events';

import { testbedApi } from '../../api/endpoints';
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Button } from '../../ui/button';
import { Select } from '../../ui/select';
import { TextField } from '../../ui/text-field';
import { useTestbed } from '../store/hooks';
import { localTime } from './event-display';
import { filterFromParams, filterToParams, selectLogEvents, type LogFilter } from './log-filter';
import { useSelection } from './selection';
import { atBottom, visibleRange } from './virtual';

const ROW_HEIGHT = 28;
const PAGE = 500;
/** A past Run is read up to this many events. */
const MAX_PAST_EVENTS = 20_000;
const ACTORS: readonly Actor[] = ['product', 'human', 'agent', 'ci', 'system'];

async function pastRunEvents(runId: string): Promise<TestbedEvent[]> {
  const all: TestbedEvent[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await testbedApi.events({ runId, limit: PAGE, ...(after ? { after } : {}) });
    all.push(...page.events);
    if (page.events.length < PAGE || all.length >= MAX_PAST_EVENTS || page.cursor === null) break;
    after = page.cursor;
  }
  return all;
}

function useRuns() {
  const { status } = useTestbed();
  return useQuery({
    queryKey: ['testbed', 'runs', status?.instanceId, status?.run?.runId ?? null] as const,
    queryFn: () => testbedApi.runs(),
    enabled: status !== null,
  });
}

function Filters({
  filter,
  setFilter,
}: {
  filter: LogFilter;
  setFilter: (next: LogFilter) => void;
}) {
  const { t } = useI18n();
  const { status } = useTestbed();
  const runs = useRuns();
  const set = (patch: Partial<LogFilter>) => setFilter({ ...filter, ...patch });
  const any = { value: '' as const, label: t('testbed.log.any') };
  return (
    <div className="tb-log__filters">
      <Select
        label={t('testbed.log.run')}
        value={filter.run}
        options={[
          { value: 'current', label: t('testbed.log.runCurrent') },
          { value: 'all', label: t('testbed.log.runAll') },
          ...(runs.data ?? []).map((run) => ({
            value: run.runId,
            label: `${run.label} (${run.runId})`,
          })),
        ]}
        onChange={(run) => set({ run })}
        testId={TESTID.testbed.eventLog.filter('run')}
      />
      <Select
        label={t('testbed.log.core')}
        value={filter.core ?? ''}
        options={[
          any,
          ...(status?.cores ?? []).map((core) => ({ value: core.id, label: core.id })),
          { value: 'testbed', label: 'testbed' },
        ]}
        onChange={(core) => set({ core: core === '' ? undefined : core })}
        testId={TESTID.testbed.eventLog.filter('core')}
      />
      <TextField
        label={t('testbed.log.kind')}
        value={filter.kind ?? ''}
        placeholder="sample.data"
        onChange={(event) =>
          set({ kind: event.target.value === '' ? undefined : event.target.value })
        }
        testId={TESTID.testbed.eventLog.filter('kind')}
      />
      <Select
        label={t('testbed.log.level')}
        value={filter.level ?? ''}
        options={[
          any,
          ...EVENT_LEVELS.map((level) => ({
            value: level,
            label: `≥ ${level}`,
          })),
        ]}
        onChange={(level) => set({ level: level === '' ? undefined : level })}
        testId={TESTID.testbed.eventLog.filter('level')}
      />
      <Select
        label={t('testbed.log.actor')}
        value={filter.actor ?? ''}
        options={[any, ...ACTORS.map((actor) => ({ value: actor, label: actor }))]}
        onChange={(actor) => set({ actor: actor === '' ? undefined : actor })}
        testId={TESTID.testbed.eventLog.filter('actor')}
      />
      <TextField
        label={t('testbed.log.search')}
        value={filter.text ?? ''}
        onChange={(event) =>
          set({ text: event.target.value === '' ? undefined : event.target.value })
        }
        testId={TESTID.testbed.eventLog.filter('text')}
      />
    </div>
  );
}

export function EventLog() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const filter = filterFromParams(params);
  const { events, status, omitted } = useTestbed();
  const { selected, select } = useSelection();
  const openRunId = status?.run?.runId ?? null;
  const past = filter.run !== 'current' && filter.run !== 'all' && filter.run !== openRunId;

  const pastEvents = useQuery({
    queryKey: ['testbed', 'run-events', filter.run] as const,
    queryFn: () => pastRunEvents(filter.run),
    enabled: past,
    staleTime: Infinity,
  });
  const source = past ? (pastEvents.data ?? []) : events;
  const rows = selectLogEvents(source, past ? { ...filter, run: 'all' } : filter, openRunId);

  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(480);
  const [following, setFollowing] = useState(true);
  const [seen, setSeen] = useState(0);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Following: stay at the bottom as rows come in. If the person scrolled up
  // since the last automatic scroll (and the scroll event has not landed yet),
  // stop following instead of pulling them back down.
  const autoTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!following || !element) return;
    if (autoTop.current !== null && element.scrollTop < autoTop.current - ROW_HEIGHT / 2) {
      setFollowing(false);
      setSeen(rows.length);
      return;
    }
    element.scrollTop = element.scrollHeight;
    autoTop.current = element.scrollTop;
  }, [following, rows.length]);

  const range = visibleRange({
    scrollTop,
    viewportHeight: height,
    rowHeight: ROW_HEIGHT,
    count: rows.length,
  });
  const unseen = following ? 0 : Math.max(0, rows.length - seen);

  return (
    <div className="tb-log" data-testid={TESTID.testbed.eventLog.root}>
      <Filters
        filter={filter}
        setFilter={(next) =>
          setParams((current) => filterToParams(next, current), { replace: true })
        }
      />
      <div className="tb-log__meta muted" role="status">
        <span data-testid={TESTID.testbed.eventLog.count}>
          {t('testbed.log.count', { n: rows.length })}
        </span>
        {omitted > 0 && (
          <span data-testid={TESTID.testbed.eventLog.omitted}>
            {t('testbed.log.omitted', { n: omitted })}
          </span>
        )}
        {past && pastEvents.isFetching && <span>{t('common.loading')}</span>}
      </div>
      <div
        ref={viewport}
        className="tb-log__viewport"
        role="list"
        aria-label={t('testbed.tab.events')}
        onScroll={(event) => {
          const element = event.currentTarget;
          setScrollTop(element.scrollTop);
          const bottom = atBottom({
            scrollTop: element.scrollTop,
            viewportHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            rowHeight: ROW_HEIGHT,
          });
          if (bottom) autoTop.current = element.scrollTop;
          if (bottom !== following) {
            setFollowing(bottom);
            setSeen(rows.length);
          }
        }}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {rows.slice(range.start, range.end).map((event, offset) => (
            <button
              key={event.id}
              type="button"
              role="listitem"
              className="tb-log__row"
              data-level={event.level}
              aria-current={selected?.id === event.id || undefined}
              style={{ top: (range.start + offset) * ROW_HEIGHT, height: ROW_HEIGHT }}
              onClick={() => select(event)}
              data-testid={TESTID.testbed.eventLog.row(event.id)}
            >
              <span className="tb-log__time">{localTime(event.ts)}</span>
              <span className="tb-log__level">{event.level}</span>
              <span className="tb-log__actor">{event.actor}</span>
              <span className="tb-log__kind">{event.kind}</span>
              <span className="tb-log__summary">{event.summary}</span>
            </button>
          ))}
        </div>
      </div>
      {!following && (
        <Button
          variant="secondary"
          onClick={() => {
            autoTop.current = null;
            setFollowing(true);
          }}
          testId={TESTID.testbed.eventLog.jumpLatest}
        >
          <ArrowDown aria-hidden size="1em" />
          {t('testbed.log.jumpLatest', { n: unseen })}
        </Button>
      )}
    </div>
  );
}
