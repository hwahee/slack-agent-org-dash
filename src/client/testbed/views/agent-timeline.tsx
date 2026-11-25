/**
 * The agent timeline (docs/testbed/dashboard.md §1): what agents did, and the
 * control calls and lease changes of everyone but people at the dashboard, in
 * time order, each with the caller's name and the first 4 characters of its
 * session. Like the event log, it follows new items at the bottom until the
 * person scrolls up.
 */
import { ArrowDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Button } from '../../ui/button';
import { useTestbedEvents } from '../store/hooks';
import { callerLabel, isAgentTimelineEvent, localTime } from './event-display';
import { useSelection } from './selection';
import { atBottom } from './virtual';

/** The newest this many are shown. */
const SHOWN = 500;
/** How close to the bottom still counts as at the bottom (px). */
const SLACK = 28;

export function AgentTimeline() {
  const { t } = useI18n();
  const { selected, select } = useSelection();
  const items = useTestbedEvents().filter(isAgentTimelineEvent).slice(-SHOWN);
  const lastId = items.at(-1)?.id ?? null;

  const viewport = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  /** The newest item when following stopped. */
  const [seenId, setSeenId] = useState<string | null>(null);

  // Following: stay at the bottom as items come in. If the person scrolled up
  // since the last automatic scroll (and the scroll event has not landed yet),
  // stop following instead of pulling them back down.
  const autoTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!following || !element) return;
    if (autoTop.current !== null && element.scrollTop < autoTop.current - SLACK / 2) {
      setFollowing(false);
      setSeenId(lastId);
      return;
    }
    element.scrollTop = element.scrollHeight;
    autoTop.current = element.scrollTop;
  }, [following, lastId]);

  const unseen = following ? 0 : items.length - (items.findIndex((e) => e.id === seenId) + 1);

  return (
    <div className="tb-timeline" data-testid={TESTID.testbed.agentTimeline.root}>
      {items.length === 0 ? (
        <p className="muted">{t('testbed.timeline.empty')}</p>
      ) : (
        <div
          ref={viewport}
          className="tb-timeline__viewport"
          onScroll={(event) => {
            const element = event.currentTarget;
            const bottom = atBottom({
              scrollTop: element.scrollTop,
              viewportHeight: element.clientHeight,
              scrollHeight: element.scrollHeight,
              rowHeight: SLACK,
            });
            if (bottom) autoTop.current = element.scrollTop;
            if (bottom !== following) {
              setFollowing(bottom);
              setSeenId(lastId);
            }
          }}
        >
          <ol className="tb-timeline__list">
            {items.map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  className="tb-timeline__item"
                  data-level={event.level}
                  aria-current={selected?.id === event.id || undefined}
                  onClick={() => select(event)}
                  data-testid={TESTID.testbed.agentTimeline.item(event.id)}
                >
                  <span className="muted">{localTime(event.ts)}</span>
                  <span className="tb-timeline__who">{callerLabel(event)}</span>
                  <span className="tb-timeline__kind">{event.kind}</span>
                  <span>{event.summary}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      {!following && (
        <Button
          variant="secondary"
          onClick={() => {
            autoTop.current = null;
            setFollowing(true);
          }}
          testId={TESTID.testbed.agentTimeline.jumpLatest}
        >
          <ArrowDown aria-hidden size="1em" />
          {t('testbed.log.jumpLatest', { n: Math.max(0, unseen) })}
        </Button>
      )}
    </div>
  );
}
