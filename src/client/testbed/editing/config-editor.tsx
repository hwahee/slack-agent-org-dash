/**
 * A core's config: the core's own form when it registered one, otherwise a
 * JSON editor (2-space indent). Saving is `PATCH /cores/:core/config`;
 * validation issues show under the editor with their paths. An `applied`
 * result shows "saved" next to the button until the next edit, the way the
 * fault-rule editor does; a `restart-required` result offers to restart now
 * (stop → start).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { testbedApi } from '../../api/endpoints';
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Alert } from '../../ui/alert';
import { TextArea } from '../../ui/text-area';
import type { ClientCoreModule } from '../registry';
import { errorLines, errorMessage, jsonErrorText } from './errors';
import { LockAwareEditor } from './lock-aware-editor';
import { OperateButton } from './operate-button';
import { useLockAwareEditor } from './use-lock-aware-editor';

type Config = Record<string, unknown>;

const toText = (config: Config) => JSON.stringify(config, null, 2);
const same = (config: Config) => config;

export function configQueryKey(core: string) {
  return ['testbed', 'config', core] as const;
}

export function ConfigEditor({ core, module }: { core: string; module?: ClientCoreModule }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: configQueryKey(core),
    queryFn: () => testbedApi.config(core),
  });
  const Form = module?.configForm;
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [restart, setRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const refetch = async () => (await config.refetch()).data;
  const textEditor = useLockAwareEditor<string, Config>({
    server: config.data,
    toDraft: toText,
    refetch,
  });
  const formEditor = useLockAwareEditor<Config, Config>({
    server: config.data,
    toDraft: same,
    refetch,
  });

  const editText = (draft: string) => {
    setSaved(false);
    textEditor.edit(draft);
  };
  const editForm = (draft: Config) => {
    setSaved(false);
    formEditor.edit(draft);
  };

  async function submit(patch: Config) {
    setProblems([]);
    setSaved(false);
    const outcome = await (Form ? formEditor : textEditor).save(() =>
      testbedApi.setConfig(core, patch),
    );
    if (outcome.ok) {
      setRestart(outcome.result.result === 'restart-required');
      setSaved(outcome.result.result === 'applied');
      queryClient.setQueryData(configQueryKey(core), outcome.result.config);
      return;
    }
    setProblems(errorLines(outcome.error, t));
  }

  async function restartNow() {
    setRestarting(true);
    try {
      await testbedApi.operate(core, 'stop');
      await testbedApi.operate(core, 'start');
      setRestart(false);
    } catch (error) {
      setProblems([errorMessage(error, t)]);
    } finally {
      setRestarting(false);
    }
  }

  const savedNote = saved && <span role="status">{t('testbed.config.saved')}</span>;

  const footer = (
    <>
      {problems.length > 0 && (
        <ul
          className="tb-editor__problems"
          role="alert"
          data-testid={TESTID.testbed.configEditor.errors(core)}
        >
          {problems.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {restart && (
        <div data-testid={TESTID.testbed.configEditor.restartNotice(core)}>
          <Alert
            tone="info"
            action={
              <OperateButton
                variant="secondary"
                loading={restarting}
                onClick={() => void restartNow()}
                testId={TESTID.testbed.configEditor.restartNow(core)}
              >
                {t('testbed.config.restartNow')}
              </OperateButton>
            }
          >
            {t('testbed.config.restartRequired')}
          </Alert>
        </div>
      )}
    </>
  );

  if (Form) {
    const value = formEditor.value;
    return (
      <LockAwareEditor editor={formEditor} draftText={toText}>
        {value && (
          <Form core={core} value={value} onChange={editForm} readOnly={formEditor.readOnly} />
        )}
        <div className="tb-editor__actions">
          <OperateButton
            onClick={() => {
              if (value) void submit(value);
            }}
            testId={TESTID.testbed.configEditor.save(core)}
          >
            {t('testbed.config.save')}
          </OperateButton>
          {savedNote}
        </div>
        {footer}
      </LockAwareEditor>
    );
  }

  const text = textEditor.value ?? '';
  return (
    <LockAwareEditor editor={textEditor} draftText={(draft) => draft}>
      <TextArea
        label={t('testbed.config.label')}
        value={text}
        rows={Math.min(16, text.split('\n').length + 1)}
        readOnly={textEditor.readOnly}
        spellCheck={false}
        onChange={(event) => editText(event.target.value)}
        testId={TESTID.testbed.configEditor.root(core)}
      />
      <div className="tb-editor__actions">
        <OperateButton
          onClick={() => {
            let patch: Config;
            try {
              patch = JSON.parse(text) as Config;
            } catch (error) {
              setSaved(false);
              setProblems([jsonErrorText(error, text, t)]);
              return;
            }
            void submit(patch);
          }}
          testId={TESTID.testbed.configEditor.save(core)}
        >
          {t('testbed.config.save')}
        </OperateButton>
        {savedNote}
      </div>
      {footer}
    </LockAwareEditor>
  );
}
