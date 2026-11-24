/**
 * A core's config: the core's own form when it registered one, otherwise a
 * JSON editor (2-space indent). Saving is `PATCH /cores/:core/config`;
 * validation issues show under the editor with their paths, and a
 * `restart-required` result offers to restart now (stop → start).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { testbedApi } from '../../api/endpoints';
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Alert } from '../../ui/alert';
import { TextArea } from '../../ui/text-area';
import type { ClientCoreModule } from '../registry';
import { errorMessage, issueLines } from './errors';
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

  async function submit(patch: Config) {
    setProblems([]);
    const outcome = await (Form ? formEditor : textEditor).save(() =>
      testbedApi.setConfig(core, patch),
    );
    if (outcome.ok) {
      setRestart(outcome.result.result === 'restart-required');
      queryClient.setQueryData(configQueryKey(core), outcome.result.config);
      return;
    }
    const lines = issueLines(outcome.error);
    setProblems(lines.length > 0 ? lines : [errorMessage(outcome.error)]);
  }

  async function restartNow() {
    setRestarting(true);
    try {
      await testbedApi.operate(core, 'stop');
      await testbedApi.operate(core, 'start');
      setRestart(false);
    } catch (error) {
      setProblems([errorMessage(error)]);
    } finally {
      setRestarting(false);
    }
  }

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
          <Form
            core={core}
            value={value}
            onChange={formEditor.edit}
            readOnly={formEditor.readOnly}
          />
        )}
        <OperateButton
          onClick={() => {
            if (value) void submit(value);
          }}
          testId={TESTID.testbed.configEditor.save(core)}
        >
          {t('testbed.config.save')}
        </OperateButton>
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
        onChange={(event) => textEditor.edit(event.target.value)}
        testId={TESTID.testbed.configEditor.root(core)}
      />
      <OperateButton
        onClick={() => {
          let patch: Config;
          try {
            patch = JSON.parse(text) as Config;
          } catch (error) {
            setProblems([t('testbed.config.notJson', { message: errorMessage(error) })]);
            return;
          }
          void submit(patch);
        }}
        testId={TESTID.testbed.configEditor.save(core)}
      >
        {t('testbed.config.save')}
      </OperateButton>
      {footer}
    </LockAwareEditor>
  );
}
