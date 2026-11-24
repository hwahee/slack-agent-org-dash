/**
 * `LockAwareEditor` — the frame every editing control sits in: the config
 * editor, action forms, the fault-rule editor and a core's own config form
 * (docs/testbed/dashboard.md §2.1). While locked it shows who took control
 * and lets the person copy their input; after the lease is released with a
 * changed server value it offers "reload" or "keep mine".
 */
import type { ReactNode } from 'react';

import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Alert } from '../../ui/alert';
import { Button } from '../../ui/button';
import { CopyButton } from '../dashboard/copy-button';
import { useLease } from '../store/hooks';
import type { LockAwareEditorApi } from './use-lock-aware-editor';

export function LockAwareEditor<D, V>({
  editor,
  draftText,
  children,
}: {
  editor: LockAwareEditorApi<D, V>;
  /** The input as text, for "copy input". */
  draftText: (draft: D) => string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { lease } = useLease();
  const { state } = editor;
  const who = lease?.name ?? lease?.actor ?? t('testbed.editor.someone');

  return (
    <div className="tb-editor" data-phase={state.phase}>
      {state.phase === 'locked' && state.draft !== null && (
        <div data-testid={TESTID.testbed.editor.lockedNotice}>
          <Alert
            tone="info"
            action={
              <CopyButton
                text={draftText(state.draft)}
                label={t('testbed.editor.input')}
                testId={TESTID.testbed.editor.copyInput}
              />
            }
          >
            {t('testbed.editor.locked', { who })}
          </Alert>
        </div>
      )}
      {state.phase === 'server-changed' && (
        <div data-testid={TESTID.testbed.editor.serverChanged}>
          <Alert
            tone="info"
            action={
              <span className="tb-editor__choice">
                <Button
                  variant="secondary"
                  onClick={editor.reload}
                  testId={TESTID.testbed.editor.reload}
                >
                  {t('testbed.editor.reload')}
                </Button>
                <Button variant="ghost" onClick={editor.keep} testId={TESTID.testbed.editor.keep}>
                  {t('testbed.editor.keep')}
                </Button>
              </span>
            }
          >
            {t('testbed.editor.serverChanged')}
          </Alert>
        </div>
      )}
      {children}
    </div>
  );
}
