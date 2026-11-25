/**
 * One card per core (docs/testbed/dashboard.md §1): title, kind, state and
 * counters; an external core's replicas; start / stop / reset; the config
 * editor; action buttons; the fault-rule editor. It folds away to its header.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import type { TestbedManifest } from '@shared/testbed/control';
import type { CoreStatus } from '@shared/testbed/core';

import { testbedApi } from '../../api/endpoints';
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Badge } from '../../ui/badge';
import { CLIENT_CORES } from '../cores';
import { ActionList } from '../editing/action-form';
import { ConfigEditor } from '../editing/config-editor';
import { errorMessage } from '../editing/errors';
import { FaultEditor } from '../editing/fault-editor';
import { OperateButton } from '../editing/operate-button';
import { ReplicaTable } from './replica-table';
import { STATE_TONE } from './state-tone';

const OPERATIONS = ['start', 'stop', 'reset'] as const;

type ManifestCore = TestbedManifest['cores'][number];

export function CoreCard({ core, status }: { core: ManifestCore; status: CoreStatus | undefined }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = status?.state ?? core.state;
  const module = CLIENT_CORES.find((entry) => entry.core === core.id);
  const bodyId = `tb-core-${core.id}`;

  async function operate(op: (typeof OPERATIONS)[number]) {
    setBusy(op);
    setError(null);
    try {
      await testbedApi.operate(core.id, op);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="tb-core-card" data-testid={TESTID.testbed.coreCard(core.id)}>
      <header className="tb-core-card__head">
        <button
          type="button"
          className="tb-core-card__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          data-testid={TESTID.testbed.coreCardToggle(core.id)}
        >
          {open ? <ChevronDown aria-hidden size="1em" /> : <ChevronRight aria-hidden size="1em" />}
          <strong>{core.title}</strong>
        </button>
        <Badge tone={STATE_TONE[state]}>{state}</Badge>
      </header>
      <span className="muted tb-core-card__meta">
        {core.id} · {core.kind}
        {core.external ? ` · ${t('testbed.core.external')}` : ''}
        {status?.detail === undefined ? '' : ` · ${status.detail}`}
      </span>

      {open && (
        <div id={bodyId} className="tb-core-card__body">
          <dl className="tb-counters">
            {Object.entries(status?.counters ?? {}).map(([name, value]) => (
              <div key={name}>
                <dt className="muted">{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          {core.external && status?.replicas && (
            <ReplicaTable core={core.id} replicas={status.replicas} />
          )}

          <div className="tb-core-card__ops">
            {OPERATIONS.map((op) => (
              <OperateButton
                key={op}
                variant={op === 'stop' ? 'danger' : 'secondary'}
                loading={busy === op}
                onClick={() => void operate(op)}
                testId={TESTID.testbed.coreOp[op](core.id)}
              >
                {t(`testbed.core.${op}`)}
              </OperateButton>
            ))}
          </div>
          {error && (
            <p className="tb-editor__problems" role="alert">
              {error}
            </p>
          )}

          <section className="tb-core-card__section" aria-label={t('testbed.config.title')}>
            <h3 className="tb-panel__subtitle">{t('testbed.config.title')}</h3>
            <ConfigEditor core={core.id} {...(module === undefined ? {} : { module })} />
          </section>

          {core.actions.some((action) => action.surfaces.includes('ui')) && (
            <section className="tb-core-card__section" aria-label={t('testbed.action.title')}>
              <h3 className="tb-panel__subtitle">{t('testbed.action.title')}</h3>
              <ActionList
                core={core.id}
                actions={core.actions}
                replicas={
                  core.external ? (status?.replicas ?? []).map((replica) => replica.id) : []
                }
              />
            </section>
          )}

          {core.faults.length > 0 && (
            <section className="tb-core-card__section" aria-label={t('testbed.faults.title')}>
              <h3 className="tb-panel__subtitle">{t('testbed.faults.title')}</h3>
              <FaultEditor core={core.id} kinds={core.faults} />
            </section>
          )}
        </div>
      )}
    </article>
  );
}
