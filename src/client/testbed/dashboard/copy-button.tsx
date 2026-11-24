import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useI18n } from '../../i18n/locale-context';
import { Button } from '../../ui/button';

/** Copies `text` to the clipboard and says so for a moment. */
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

  return (
    <Button
      variant="ghost"
      testId={testId}
      aria-label={t('testbed.copy.label', { what: label })}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? <Check aria-hidden size="1em" /> : <Copy aria-hidden size="1em" />}
      {copied ? t('testbed.copy.done') : t('testbed.copy.action')}
    </Button>
  );
}
