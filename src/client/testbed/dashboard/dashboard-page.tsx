/**
 * `/` — the testbed dashboard shell (docs/testbed/dashboard.md).
 *
 * Status bar on top; below it the core column (connection panel, cores), the
 * main area (tabs) and the detail panel. Under 1024 px the two side columns
 * open as overlays instead (a sidebar and a bottom sheet). Live state comes
 * from the store over `/testbed/ws`; when sign-in is on and nobody is signed
 * in, the page asks to sign in instead.
 */
import { useQuery } from '@tanstack/react-query';
import { PanelLeft, PanelRight } from 'lucide-react';
import { useCallback, useState, type ComponentType } from 'react';

import { testbedApi } from '../../api/endpoints';
import { AccountControls } from '../../auth/account-controls';
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Alert } from '../../ui/alert';
import { Button } from '../../ui/button';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the bodies read the testbed store, a context of THIS subtree (case 1)
import { BottomSheet, Sidebar } from '../../ui/overlay/declarative';
import { Spinner } from '../../ui/spinner';
import { CLIENT_CORES } from '../cores';
import { dashboardTabs } from '../registry';
import { AgentTimeline } from '../views/agent-timeline';
import { DetailPanel } from '../views/detail-panel';
import { EventLog } from '../views/event-log';
import { RunsPanel } from '../views/runs-panel';
import { SelectionProvider } from '../views/selection';
import { StatsPanel } from '../views/stats-panel';
import { TestbedStoreProvider, useDismissRestart, useTestbed } from '../store/hooks';
import { CoreColumn } from './core-column';
import { LeaseBanner, useLeaseAttribute } from './lease-banner';
import { StatusBar } from './status-bar';
import { DashboardTabs } from './tabs';
import { useMediaQuery } from './use-media-query';

const WIDE = '(min-width: 1024px)';

/** The common tabs' views (docs/testbed/dashboard.md §1). */
const COMMON_VIEWS: Record<string, ComponentType> = {
  events: EventLog,
  stats: StatsPanel,
  runs: RunsPanel,
  agent: AgentTimeline,
};

function LoginRequired() {
  const { t } = useI18n();
  return (
    <section className="tb-login" data-testid={TESTID.testbed.loginRequired}>
      <h2>{t('testbed.login.title')}</h2>
      <p className="muted">{t('testbed.login.description')}</p>
      <AccountControls />
    </section>
  );
}

function Dashboard() {
  const { t } = useI18n();
  const snapshot = useTestbed();
  const dismissRestart = useDismissRestart();
  const wide = useMediaQuery(WIDE);
  const [coresOpen, setCoresOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  useLeaseAttribute();
  // Goes down through context: on narrow screens, picking an event opens the detail sheet.
  const onSelect = useCallback(() => {
    if (!wide) setDetailOpen(true);
  }, [wide]);

  const instanceId = snapshot.status?.instanceId;
  const manifest = useQuery({
    queryKey: ['testbed', 'manifest', instanceId] as const,
    queryFn: () => testbedApi.manifest(),
    enabled: instanceId !== undefined,
  });

  if (snapshot.connection === 'unauthorized') return <LoginRequired />;

  const tabs = dashboardTabs(CLIENT_CORES).map((tab) => {
    const component = tab.component ?? COMMON_VIEWS[tab.id];
    return component === undefined ? tab : { ...tab, component };
  });
  const column = manifest.data ? (
    <CoreColumn manifest={manifest.data} status={snapshot.status} />
  ) : (
    <Spinner label={t('common.loading')} />
  );

  return (
    <SelectionProvider onSelect={onSelect}>
      <div className="tb-dashboard" data-testid={TESTID.testbed.dashboard}>
        <StatusBar
          manifest={manifest.data}
          status={snapshot.status}
          connection={snapshot.connection}
        />
        <LeaseBanner />
        {snapshot.restarted && (
          <div data-testid={TESTID.testbed.restartNotice}>
            <Alert
              tone="info"
              action={
                <Button
                  variant="ghost"
                  onClick={dismissRestart}
                  testId={TESTID.testbed.restartDismiss}
                >
                  {t('common.close')}
                </Button>
              }
            >
              {t('testbed.restarted')}
            </Alert>
          </div>
        )}

        {!wide && (
          <div className="tb-dashboard__toolbar">
            <Button
              variant="secondary"
              onClick={() => setCoresOpen(true)}
              testId={TESTID.testbed.openCores}
            >
              <PanelLeft aria-hidden size="1em" />
              {t('testbed.cores.open')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setDetailOpen(true)}
              testId={TESTID.testbed.openDetail}
            >
              <PanelRight aria-hidden size="1em" />
              {t('testbed.detail.title')}
            </Button>
          </div>
        )}

        <div className="tb-layout" data-wide={wide || undefined}>
          {wide && <aside className="tb-layout__side">{column}</aside>}
          <div className="tb-layout__main">
            <DashboardTabs tabs={tabs} />
          </div>
          {wide && (
            <aside className="tb-layout__side">
              <DetailPanel />
            </aside>
          )}
        </div>

        {!wide && (
          <>
            <Sidebar
              modality="modal"
              open={coresOpen}
              onClose={() => setCoresOpen(false)}
              title={t('testbed.cores.open')}
              testId={TESTID.testbed.coresOverlay}
            >
              {column}
            </Sidebar>
            <BottomSheet
              open={detailOpen}
              onClose={() => setDetailOpen(false)}
              title={t('testbed.detail.title')}
              testId={TESTID.testbed.detailOverlay}
            >
              <DetailPanel />
            </BottomSheet>
          </>
        )}
      </div>
    </SelectionProvider>
  );
}

export function DashboardPage() {
  return (
    <TestbedStoreProvider>
      <Dashboard />
    </TestbedStoreProvider>
  );
}
