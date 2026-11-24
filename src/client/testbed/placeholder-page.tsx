/**
 * `/` until the dashboard shell arrives (P3, docs/testbed/dashboard.md): an
 * empty spot that only says where the testbed is operated from.
 */
import { useI18n } from '../i18n/locale-context';
import { TESTID } from '../testing/testids';

export function PlaceholderPage() {
  const { t } = useI18n();
  return (
    <section data-testid={TESTID.testbed.placeholder} aria-labelledby="testbed-placeholder-heading">
      <h2 id="testbed-placeholder-heading">{t('testbed.placeholder.title')}</h2>
      <p className="muted">{t('testbed.placeholder.description')}</p>
    </section>
  );
}
