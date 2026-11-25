/**
 * The detail panel (docs/testbed/dashboard.md §1): the picked event in full
 * (`GET /events/:id`), its envelope fields and payload tree, and the other
 * events with the same `correlationId`, each a click away. One button copies
 * the whole event as JSON.
 */
import { useQuery } from '@tanstack/react-query';

import type { TestbedEvent } from '@shared/testbed/events';

import { ApiRequestError } from '../../api/http';
import { testbedApi } from '../../api/endpoints';
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { CopyButton } from '../dashboard/copy-button';
import { localTime } from './event-display';
import { JsonViewer } from './json-viewer';
import { useSelection } from './selection';

const ENVELOPE = [
  'id',
  'runId',
  'core',
  'kind',
  'level',
  'actor',
  'correlationId',
  'latencyMs',
  'truncated',
] as const;

function Group({ event }: { event: TestbedEvent }) {
  const { t } = useI18n();
  const { select } = useSelection();
  const correlationId = event.correlationId;
  const group = useQuery({
    queryKey: ['testbed', 'group', correlationId, event.runId] as const,
    queryFn: () =>
      testbedApi.events({
        correlationId,
        limit: 200,
        ...(event.runId === null ? {} : { runId: event.runId }),
      }),
    enabled: correlationId !== undefined,
  });
  if (correlationId === undefined) return null;
  return (
    <section
      aria-label={t('testbed.detail.group', { id: correlationId })}
      data-testid={TESTID.testbed.detail.group}
    >
      <h3 className="tb-panel__subtitle">{t('testbed.detail.group', { id: correlationId })}</h3>
      <ul className="tb-detail__group">
        {(group.data?.events ?? []).map((member) => (
          <li key={member.id}>
            <button
              type="button"
              className="tb-detail__group-item"
              aria-current={member.id === event.id || undefined}
              onClick={() => select(member)}
              data-testid={TESTID.testbed.detail.groupItem(member.id)}
            >
              <span className="muted">{localTime(member.ts)}</span> {member.kind} — {member.summary}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DetailPanel() {
  const { t } = useI18n();
  const { selected } = useSelection();
  const full = useQuery({
    queryKey: ['testbed', 'event', selected?.id] as const,
    queryFn: () => testbedApi.event(selected?.id ?? ''),
    enabled: selected !== null,
    // Out of the ring buffer (a past Run): the event from the list is complete already.
    retry: (count, error) =>
      !(error instanceof ApiRequestError && error.status === 404) && count < 1,
  });
  const event = full.data ?? selected;

  return (
    <section
      className="tb-panel"
      aria-labelledby="tb-detail-title"
      data-testid={TESTID.testbed.detail.root}
    >
      <div className="tb-detail__head">
        <h2 id="tb-detail-title" className="tb-panel__title">
          {t('testbed.detail.title')}
        </h2>
        {event !== null && (
          <CopyButton
            text={JSON.stringify(event, null, 2)}
            label={t('testbed.detail.eventJson')}
            testId={TESTID.testbed.detail.copyEvent}
          />
        )}
      </div>
      {event === null ? (
        <p className="muted">{t('testbed.detail.empty')}</p>
      ) : (
        <>
          <p className="tb-detail__summary">{event.summary}</p>
          <dl className="tb-detail__envelope">
            <div>
              <dt className="muted">ts</dt>
              <dd>
                {localTime(event.ts)} <span className="muted">({event.ts})</span>
              </dd>
            </div>
            {ENVELOPE.filter((field) => event[field] !== undefined).map((field) => (
              <div key={field}>
                <dt className="muted">{field}</dt>
                <dd>
                  <code>{String(event[field])}</code>
                </dd>
              </div>
            ))}
          </dl>
          <div data-testid={TESTID.testbed.detail.payload}>
            <JsonViewer value={event.payload} root="payload" />
          </div>
          <Group event={event} />
        </>
      )}
    </section>
  );
}
