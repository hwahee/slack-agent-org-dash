/**
 * The left column: the connection panel, then one entry per core. The full
 * core cards (operations, config, actions, faults) arrive with M8.
 */
import type { TestbedManifest, TestbedStatus } from '@shared/testbed/control';

import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Badge } from '../../ui/badge';
import { ConnectionPanel } from './connection-panel';

const STATE_TONE = {
  running: 'success',
  error: 'danger',
  starting: 'warning',
  stopping: 'warning',
  idle: 'neutral',
  stopped: 'neutral',
} as const;

export function CoreColumn({
  manifest,
  status,
}: {
  manifest: TestbedManifest;
  status: TestbedStatus | null;
}) {
  const { t } = useI18n();
  return (
    <div className="tb-column" data-testid={TESTID.testbed.coreColumn}>
      <ConnectionPanel manifest={manifest} status={status} />
      <section className="tb-panel" aria-labelledby="tb-cores-title">
        <h2 id="tb-cores-title" className="tb-panel__title">
          {t('testbed.cores.title')}
        </h2>
        <ul className="tb-core-list">
          {(status?.cores ?? []).map((core) => (
            <li
              key={core.id}
              className="tb-core-list__item"
              data-testid={TESTID.testbed.coreCard(core.id)}
            >
              <div className="tb-core-list__head">
                <strong>{core.title}</strong>
                <Badge tone={STATE_TONE[core.state]}>{core.state}</Badge>
              </div>
              <span className="muted">
                {core.id} · {core.kind}
                {core.detail === undefined ? '' : ` · ${core.detail}`}
              </span>
              <dl className="tb-counters">
                {Object.entries(core.counters).map(([name, value]) => (
                  <div key={name}>
                    <dt className="muted">{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
