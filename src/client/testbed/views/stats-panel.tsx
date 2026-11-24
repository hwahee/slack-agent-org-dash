/**
 * The statistics tab (docs/testbed/dashboard.md §1): over the open Run's
 * events (the whole live window when no Run is open) — counts by kind and
 * level, the error rate, latency per kind, and events per second.
 */
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { useTestbed, useTestbedEvents } from '../store/hooks';
import { Sparkline } from './sparkline';
import { computeStats } from './stats';

const round = (value: number) => (Math.round(value * 10) / 10).toLocaleString();

export function StatsPanel() {
  const { t } = useI18n();
  const { status } = useTestbed();
  const open = status?.run ?? null;
  const runEvents = useTestbedEvents({ runId: 'current' });
  const all = useTestbedEvents();
  const events = open ? runEvents : all;
  const stats = computeStats(events);

  return (
    <div className="tb-stats" data-testid={TESTID.testbed.stats.root}>
      <p className="muted">
        {open ? t('testbed.stats.scopeRun', { label: open.label }) : t('testbed.stats.scopeAll')} ·{' '}
        {t('testbed.log.count', { n: stats.total })} ·{' '}
        {t('testbed.stats.errorRate', { rate: round(stats.errorRate * 100) })}
      </p>
      <Sparkline events={all} label={t('testbed.stats.perSecond')} />

      <div className="tb-stats__grid">
        <table className="tb-table">
          <caption>{t('testbed.stats.byKind')}</caption>
          <tbody>
            {stats.byKind.map((row) => (
              <tr key={row.kind}>
                <th scope="row">{row.kind}</th>
                <td>{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="tb-table">
          <caption>{t('testbed.stats.byLevel')}</caption>
          <tbody>
            {Object.entries(stats.byLevel).map(([level, count]) => (
              <tr key={level}>
                <th scope="row">{level}</th>
                <td>{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {stats.latency.length > 0 && (
        <table className="tb-table" data-testid={TESTID.testbed.stats.latency}>
          <caption>{t('testbed.stats.latency')}</caption>
          <thead>
            <tr>
              <th scope="col">kind</th>
              <th scope="col">n</th>
              <th scope="col">{t('testbed.stats.mean')}</th>
              <th scope="col">p95</th>
              <th scope="col">{t('testbed.stats.max')}</th>
            </tr>
          </thead>
          <tbody>
            {stats.latency.map((row) => (
              <tr key={row.kind}>
                <th scope="row">{row.kind}</th>
                <td>{row.count}</td>
                <td>{round(row.mean)} ms</td>
                <td>{row.p95} ms</td>
                <td>{row.max} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
