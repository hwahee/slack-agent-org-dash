/**
 * The agent timeline (docs/testbed/dashboard.md §1): what agents did, every
 * control call and every lease change, in time order, each with the caller's
 * name and the first 4 characters of its session.
 */
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { useTestbedEvents } from '../store/hooks';
import { callerLabel, isAgentTimelineEvent, localTime } from './event-display';
import { useSelection } from './selection';

/** The newest this many are shown. */
const SHOWN = 500;

export function AgentTimeline() {
  const { t } = useI18n();
  const { selected, select } = useSelection();
  const items = useTestbedEvents().filter(isAgentTimelineEvent).slice(-SHOWN);
  return (
    <div className="tb-timeline" data-testid={TESTID.testbed.agentTimeline.root}>
      {items.length === 0 ? (
        <p className="muted">{t('testbed.timeline.empty')}</p>
      ) : (
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
      )}
    </div>
  );
}
