/**
 * The left column: the connection panel, then one card per core.
 */
import type { TestbedManifest, TestbedStatus } from '@shared/testbed/control';

import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { ConnectionPanel } from './connection-panel';
import { CoreCard } from './core-card';

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
        {manifest.cores.map((core) => (
          <CoreCard
            key={core.id}
            core={core}
            status={status?.cores.find((entry) => entry.id === core.id)}
          />
        ))}
      </section>
    </div>
  );
}
