import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useI18n } from '../../i18n/locale-context';
import { Button } from '../../ui/button';

/**
 * Copies `text` to the clipboard: an icon only, so it fits next to what it
 * copies. The label is the accessible name and the tooltip; after a copy the
 * icon turns into a check and "Copied" is announced for a moment.
 */
export function CopyButton({
  text,
  label,
  testId,
}: {
  text: string;
  label: string;
  testId: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const name = t('testbed.copy.label', { what: label });

  return (
    <Button
      variant="ghost"
      data-copy-button=""
      testId={testId}
      aria-label={name}
      title={copied ? t('testbed.copy.done') : name}
      data-copied={copied || undefined}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? <Check aria-hidden size="1em" /> : <Copy aria-hidden size="1em" />}
      <span className="visually-hidden" aria-live="polite">
        {copied ? t('testbed.copy.done') : ''}
      </span>
    </Button>
  );
}
