/**
 * The Run tab (docs/testbed/dashboard.md §1): the open Run with its end
 * button, a start form (label, seed, end the open one), the past Runs and,
 * for the one picked, its summary and export link. A Run closed by someone
 * other than who opened it, or replaced / closed by a restart, says so.
 * "End the open Run" shows only while one is open and holds for that Run
 * only; a successful start clears the form.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { Caller } from '@shared/testbed/events';
import type { RunMeta } from '@shared/testbed/runs';

import { testbedApi } from '../../api/endpoints';
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Badge } from '../../ui/badge';
import { Checkbox } from '../../ui/checkbox';
import { TextField } from '../../ui/text-field';
import { errorMessage } from '../editing/errors';
import { OperateButton } from '../editing/operate-button';
import { useTestbed } from '../store/hooks';
import { mmss, useNow } from '../use-now';
import { localTime } from './event-display';

function who(caller: Caller | undefined): string {
  if (!caller) return '?';
  const id = caller.sessionId ?? caller.leaseId;
  return `${caller.name ?? caller.actor}${id === undefined ? '' : ` · ${id}`}`;
}

function sameCaller(a: Caller | undefined, b: Caller | undefined): boolean {
  return (
    a?.actor === b?.actor &&
    a?.name === b?.name &&
    a?.sessionId === b?.sessionId &&
    a?.leaseId === b?.leaseId
  );
}

function OpenRun({ run }: { run: RunMeta }) {
  const { t } = useI18n();
  const now = useNow();
  return (
    <dl className="tb-detail__envelope" data-testid={TESTID.testbed.runs.open}>
      <div>
        <dt className="muted">label</dt>
        <dd>{run.label}</dd>
      </div>
      <div>
        <dt className="muted">runId</dt>
        <dd>
          <code>{run.runId}</code>
        </dd>
      </div>
      <div>
        <dt className="muted">{t('testbed.runs.started')}</dt>
        <dd>{localTime(run.startedAt)}</dd>
      </div>
      <div>
        <dt className="muted">{t('testbed.runs.openedBy')}</dt>
        <dd>{who(run.openedBy)}</dd>
      </div>
      <div>
        <dt className="muted">{t('testbed.runs.elapsed')}</dt>
        <dd>{mmss(now - Date.parse(run.startedAt))}</dd>
      </div>
      <div>
        <dt className="muted">seed</dt>
        <dd>
          <code>{run.seed}</code>
        </dd>
      </div>
    </dl>
  );
}

function Summary({ run }: { run: RunMeta }) {
  const { t } = useI18n();
  const summary = run.summary;
  const closedByOther = run.endedBy !== undefined && !sameCaller(run.openedBy, run.endedBy);
  return (
    <div className="tb-runs__summary" data-testid={TESTID.testbed.runs.summary}>
      <h3 className="tb-panel__subtitle">
        {run.label} <code className="muted">{run.runId}</code>
      </h3>
      <p className="tb-runs__badges">
        {run.endReason === 'replaced' && <Badge tone="warning">{t('testbed.runs.replaced')}</Badge>}
        {run.endReason === 'restart' && <Badge tone="warning">{t('testbed.runs.restart')}</Badge>}
        {closedByOther && <Badge tone="warning">{t('testbed.runs.closedByOther')}</Badge>}
      </p>
      <p className="muted">
        {t('testbed.runs.by', { opened: who(run.openedBy), ended: who(run.endedBy) })}
        {summary
          ? ` · ${t('testbed.runs.duration', { seconds: (summary.durationMs / 1000).toFixed(1) })}`
          : ''}
      </p>
      {summary && (
        <>
          <table className="tb-table">
            <caption>{t('testbed.stats.byKind')}</caption>
            <tbody>
              {Object.entries(summary.byKind)
                .sort(([, a], [, b]) => b - a)
                .map(([kind, count]) => (
                  <tr key={kind}>
                    <th scope="row">{kind}</th>
                    <td>{count}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="muted">
            {Object.entries(summary.byLevel)
              .map(([level, count]) => `${level} ${count}`)
              .join(' · ')}
          </p>
          {summary.topErrors.length > 0 && (
            <ul className="tb-runs__errors">
              {summary.topErrors.map((error) => (
                <li key={error.kind}>
                  <strong>{error.kind}</strong> ×{error.count} — {error.summary}
                </li>
              ))}
            </ul>
          )}
          {summary.checks.length > 0 && (
            <ul className="tb-runs__checks">
              {summary.checks.map((check, index) => (
                <li key={index}>
                  <Badge tone={check.pass ? 'success' : 'danger'}>
                    {check.pass ? 'pass' : 'fail'}
                  </Badge>{' '}
                  {check.label ?? t('testbed.runs.check')} ({check.matched})
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <a href={testbedApi.exportUrl(run.runId)} download data-testid={TESTID.testbed.runs.export}>
        {t('testbed.runs.export')}
      </a>
    </div>
  );
}

export function RunsPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { status } = useTestbed();
  const open = status?.run ?? null;
  const runs = useQuery({
    queryKey: ['testbed', 'runs', status?.instanceId, open?.runId ?? null] as const,
    queryFn: () => testbedApi.runs(),
    enabled: status !== null,
  });
  const [label, setLabel] = useState('');
  const [seed, setSeed] = useState('');
  /** The open Run the person ticked "end the open Run" for — another Run unticks it. */
  const [endActiveFor, setEndActiveFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  const past = (runs.data ?? []).filter((run) => run.endedAt !== undefined);
  const shown = past.find((run) => run.runId === picked) ?? null;
  const endActive = open !== null && endActiveFor === open.runId;

  async function act(fn: () => Promise<RunMeta>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const run = await fn();
      if (run.endedAt !== undefined) setPicked(run.runId);
      await queryClient.invalidateQueries({ queryKey: ['testbed', 'runs'] });
      return true;
    } catch (failure) {
      setError(errorMessage(failure, t));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const started = await act(() =>
      testbedApi.startRun({
        label: label.trim(),
        ...(seed.trim() === '' ? {} : { seed: seed.trim() }),
        ...(endActive ? { endActive: true } : {}),
      }),
    );
    if (!started) return;
    setLabel('');
    setSeed('');
    setEndActiveFor(null);
  }

  return (
    <div className="tb-runs">
      <section aria-labelledby="tb-runs-open">
        <h3 id="tb-runs-open" className="tb-panel__subtitle">
          {t('testbed.runs.openTitle')}
        </h3>
        {open ? (
          <>
            <OpenRun run={open} />
            <OperateButton
              variant="danger"
              loading={busy}
              onClick={() => void act(() => testbedApi.endRun())}
              testId={TESTID.testbed.runs.end}
            >
              {t('testbed.runs.end')}
            </OperateButton>
          </>
        ) : (
          <p className="muted">{t('testbed.status.noRun')}</p>
        )}
      </section>

      <section aria-labelledby="tb-runs-start" className="tb-runs__start">
        <h3 id="tb-runs-start" className="tb-panel__subtitle">
          {t('testbed.runs.startTitle')}
        </h3>
        <TextField
          label="label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          testId={TESTID.testbed.runs.label}
        />
        <TextField
          label={`seed (${t('testbed.form.optional')})`}
          value={seed}
          onChange={(event) => setSeed(event.target.value)}
          testId={TESTID.testbed.runs.seed}
        />
        {open && (
          <Checkbox
            label={t('testbed.runs.endActive')}
            checked={endActive}
            onChange={(checked) => setEndActiveFor(checked ? open.runId : null)}
            testId={TESTID.testbed.runs.endActive}
          />
        )}
        <OperateButton
          loading={busy}
          onClick={() => {
            if (label.trim() === '') {
              setError(t('testbed.runs.labelRequired'));
              return;
            }
            void start();
          }}
          testId={TESTID.testbed.runs.start}
        >
          {t('testbed.runs.start')}
        </OperateButton>
        {error && (
          <p className="tb-editor__problems" role="alert">
            {error}
          </p>
        )}
      </section>

      <section aria-labelledby="tb-runs-past">
        <h3 id="tb-runs-past" className="tb-panel__subtitle">
          {t('testbed.runs.pastTitle')}
        </h3>
        {past.length === 0 ? (
          <p className="muted">{t('testbed.runs.none')}</p>
        ) : (
          <ul className="tb-runs__list">
            {past.map((run) => (
              <li key={run.runId}>
                <button
                  type="button"
                  className="tb-runs__item"
                  aria-current={run.runId === picked || undefined}
                  onClick={() => setPicked(run.runId)}
                  data-testid={TESTID.testbed.runs.item(run.runId)}
                >
                  <strong>{run.label}</strong> <code className="muted">{run.runId}</code>{' '}
                  <span className="muted">
                    {localTime(run.startedAt)} · {run.endReason}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {shown && <Summary run={shown} />}
      </section>
    </div>
  );
}
