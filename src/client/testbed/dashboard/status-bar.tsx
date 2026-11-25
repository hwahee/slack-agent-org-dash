/**
 * Top of the dashboard: who this testbed is, each core's state, the open Run
 * and whether the live stream is connected (docs/testbed/dashboard.md §1).
 */
import type { TestbedManifest, TestbedStatus } from '@shared/testbed/control';

import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import type { ConnectionState } from '../store/store';
import { mmss, useNow } from '../use-now';

function RunTag({ run }: { run: NonNullable<TestbedStatus['run']> }) {
  const { t } = useI18n();
  const now = useNow();
  const elapsed = mmss(now - Date.parse(run.startedAt));
  return (
    <span className="tb-status-bar__run" data-testid={TESTID.testbed.statusBar.run}>
      {t('testbed.status.run', { label: run.label, elapsed })}
    </span>
  );
}

export function StatusBar({
  manifest,
  status,
  connection,
}: {
  manifest: TestbedManifest | undefined;
  status: TestbedStatus | null;
  connection: ConnectionState;
}) {
  const { t } = useI18n();
  const instanceId = status?.instanceId ?? manifest?.instanceId ?? '';
  return (
    <div className="tb-status-bar" data-testid={TESTID.testbed.statusBar.root}>
      <div className="tb-status-bar__identity">
        <strong>{manifest?.name ?? '…'}</strong>
        <span className="muted">{manifest?.version}</span>
        <span className="muted">
          {t('testbed.status.instance', { id: instanceId.slice(0, 8) })}
        </span>
      </div>
      <ul className="tb-status-bar__cores" aria-label={t('testbed.status.cores')}>
        {(status?.cores ?? []).map((core) => (
          <li key={core.id} className="tb-status-bar__core">
            <span
              className="tb-dot"
              data-state={core.state}
              role="img"
              aria-label={
                core.external && core.replicas
                  ? t('testbed.status.coreReplicas', {
                      core: core.id,
                      state: core.state,
                      n: core.replicas.length,
                    })
                  : t('testbed.status.core', { core: core.id, state: core.state })
              }
              data-testid={TESTID.testbed.statusBar.core(core.id)}
            />
            <span aria-hidden>{core.id}</span>
          </li>
        ))}
      </ul>
      {status?.run ? (
        <RunTag run={status.run} />
      ) : (
        <span className="tb-status-bar__run muted" data-testid={TESTID.testbed.statusBar.run}>
          {t('testbed.status.noRun')}
        </span>
      )}
      <span
        className="tb-status-bar__connection"
        data-connection={connection}
        role="status"
        data-testid={TESTID.testbed.statusBar.connection}
      >
        {t(`testbed.connection.state.${connection}`)}
      </span>
    </div>
  );
}
