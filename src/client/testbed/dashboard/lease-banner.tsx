/**
 * The control lease, as people see it (docs/testbed/dashboard.md §2): a
 * banner with the holder, its session and the time left (ticking every
 * second), and `<html data-lease>` for styling and automation. There is no
 * button to take or break the lease here, by design.
 */
import { useEffect } from 'react';

import { Alert } from '../../ui/alert';
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { useLease } from '../store/hooks';
import { mmss, useNow } from '../use-now';

/** Keeps `<html data-lease="none|agent|ci">` in step with the lease. */
export function useLeaseAttribute(): void {
  const { lease } = useLease();
  const holder = lease?.actor ?? 'none';
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.lease = holder;
    return () => {
      delete root.dataset.lease;
    };
  }, [holder]);
}

export function LeaseBanner() {
  const { t } = useI18n();
  const { lease, receivedAt } = useLease();
  const now = useNow();
  if (!lease) return null;
  const remaining = lease.remainingMs - (now - receivedAt);
  return (
    <div className="tb-lease-banner" data-testid={TESTID.testbed.leaseBanner}>
      <Alert tone="info">
        {t('testbed.lease.banner', {
          who: lease.name ?? lease.actor,
          session: lease.holder,
          remaining: mmss(remaining),
        })}
      </Alert>
    </div>
  );
}
