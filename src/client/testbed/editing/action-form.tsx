/**
 * One button per action the core shows in the UI (`surfaces` has `ui`);
 * pressing it opens a form built from the action's input schema
 * (./schema-form.ts), or a JSON editor for schemas the form does not cover.
 * The output JSON or the error sentence shows under the form. Read-only
 * actions (`mutating: false`) run even while the lease is held. An external
 * core's form picks its target (every replica, or one); the output then
 * shows replica by replica.
 */
import { useState } from 'react';

import type { TestbedManifest } from '@shared/testbed/control';

import { testbedApi } from '../../api/endpoints';
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Select } from '../../ui/select';
import { TextArea } from '../../ui/text-area';
import { TextField } from '../../ui/text-field';
import { errorLines, issuesOf, issueText, jsonErrorText } from './errors';
import { LockAwareEditor } from './lock-aware-editor';
import { OperateButton } from './operate-button';
import { formInput, formSpec, initialValues, type FormValues } from './schema-form';
import { useLockAwareEditor } from './use-lock-aware-editor';

type Action = TestbedManifest['cores'][number]['actions'][number];

/** Nothing on the server to drift from: an action form starts empty every time. */
const NO_SERVER = {};
const refetchNothing = () => Promise.resolve(NO_SERVER);

interface ReplicaSlot {
  replica: string;
  ok: boolean;
  text: string;
}

/** Output to show, replica by replica: one target → that replica; every replica → its slots. */
function byReplica(
  output: unknown,
  target: string,
  replicas: readonly string[],
): ReplicaSlot[] | null {
  const one = (replica: string): ReplicaSlot[] => [
    { replica, ok: true, text: JSON.stringify(output, null, 2) },
  ];
  if (replicas.length === 0) return null;
  if (target !== '') return one(target);
  if (replicas.length === 1) return one(replicas[0] ?? '');
  if (typeof output !== 'object' || output === null) return null;
  const slots = output as Record<string, unknown>;
  return replicas
    .filter((replica) => replica in slots)
    .map((replica) => {
      const slot = slots[replica];
      // A replica that failed holds { error: { code, message } } (protocol §6).
      const failed = typeof slot === 'object' && slot !== null && 'error' in slot;
      return { replica, ok: !failed, text: JSON.stringify(slot, null, 2) };
    });
}

function ActionForm({
  core,
  action,
  replicas,
}: {
  core: string;
  action: Action;
  replicas: readonly string[];
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState('');
  const spec = formSpec(action.inputSchema);
  const fields = spec.kind === 'fields' ? spec.fields : [];
  const [result, setResult] = useState<{
    ok: boolean;
    text: string;
    replicas?: ReplicaSlot[];
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const editor = useLockAwareEditor<FormValues | string, object>({
    server: NO_SERVER,
    toDraft: () => (spec.kind === 'fields' ? initialValues(fields) : '{}'),
    refetch: refetchNothing,
    lockable: action.mutating,
  });
  const value = editor.value ?? '{}';
  const asText = (draft: FormValues | string) =>
    typeof draft === 'string' ? draft : JSON.stringify(formInput(fields, draft).input, null, 2);

  async function run() {
    let input: unknown;
    if (typeof value === 'string') {
      try {
        input = JSON.parse(value) as unknown;
      } catch (error) {
        setResult({ ok: false, text: jsonErrorText(error, value, t) });
        return;
      }
    } else {
      const read = formInput(fields, value);
      const messages = Object.fromEntries(
        Object.entries(read.errors).map(([name, code]) => [name, t(`testbed.form.${code}`)]),
      );
      setFieldErrors(messages);
      if (Object.keys(messages).length > 0) return;
      input = read.input;
    }
    setRunning(true);
    const picked = target === '' ? undefined : target;
    const outcome = await editor.save(
      () => testbedApi.invokeAction(core, action.name, input, picked),
      { keepDraft: true },
    );
    setRunning(false);
    if (!outcome.ok) {
      // Each issue as `field: sentence`; a form field the server named shows it too.
      setResult({ ok: false, text: errorLines(outcome.error, t).join('\n') });
      const named = issuesOf(outcome.error).filter((issue) =>
        fields.some((field) => field.name === issue.path),
      );
      setFieldErrors(
        Object.fromEntries(named.map((issue) => [issue.path ?? '', issueText(issue, t)])),
      );
      return;
    }
    const split = byReplica(outcome.result, target, replicas);
    setResult({
      ok: true,
      text: JSON.stringify(outcome.result, null, 2),
      ...(split === null ? {} : { replicas: split }),
    });
  }

  const setField = (name: string, next: string | boolean) => {
    if (typeof value !== 'string') editor.edit({ ...value, [name]: next });
  };

  return (
    <LockAwareEditor editor={editor} draftText={asText}>
      <p className="muted tb-action__description">{action.description}</p>
      {replicas.length > 0 && (
        <Select
          label={t('testbed.action.target')}
          value={target}
          options={[
            { value: '', label: t('testbed.action.targetAll') },
            ...replicas.map((replica) => ({ value: replica, label: replica })),
          ]}
          onChange={setTarget}
          testId={TESTID.testbed.action.target(core, action.name)}
        />
      )}
      {typeof value === 'string' ? (
        <TextArea
          label={t('testbed.action.input')}
          value={value}
          readOnly={editor.readOnly}
          spellCheck={false}
          onChange={(event) => editor.edit(event.target.value)}
          testId={TESTID.testbed.action.field(core, action.name, 'json')}
        />
      ) : (
        fields.map((field) => {
          const testId = TESTID.testbed.action.field(core, action.name, field.name);
          const label = field.required
            ? field.name
            : `${field.name} (${t('testbed.form.optional')})`;
          const current = value[field.name];
          if (field.type === 'boolean') {
            return (
              <Checkbox
                key={field.name}
                label={label}
                checked={current === true}
                disabled={editor.readOnly}
                onChange={(checked) => setField(field.name, checked)}
                testId={testId}
              />
            );
          }
          if (field.enum) {
            const options = [
              ...(field.required ? [] : [{ value: '', label: '—' }]),
              ...field.enum.map((option) => ({ value: option, label: option })),
            ];
            return (
              <Select
                key={field.name}
                label={label}
                value={typeof current === 'string' ? current : ''}
                options={options}
                disabled={editor.readOnly}
                onChange={(next) => setField(field.name, next)}
                testId={testId}
              />
            );
          }
          const error = fieldErrors[field.name];
          return (
            <TextField
              key={field.name}
              label={label}
              value={typeof current === 'string' ? current : ''}
              readOnly={editor.readOnly}
              inputMode={field.type === 'string' ? undefined : 'decimal'}
              {...(field.minLength === undefined ? {} : { minLength: field.minLength })}
              {...(field.maxLength === undefined ? {} : { maxLength: field.maxLength })}
              {...(field.minimum === undefined ? {} : { min: field.minimum })}
              {...(field.maximum === undefined ? {} : { max: field.maximum })}
              {...(error === undefined ? {} : { error })}
              onChange={(event) => setField(field.name, event.target.value)}
              testId={testId}
            />
          );
        })
      )}
      <OperateButton
        lockable={action.mutating}
        loading={running}
        onClick={() => void run()}
        testId={TESTID.testbed.action.run(core, action.name)}
      >
        {t('testbed.action.run')}
      </OperateButton>
      {result &&
        (result.replicas ? (
          <div
            className="tb-action__replicas"
            data-testid={TESTID.testbed.action.result(core, action.name)}
          >
            {result.replicas.map((slot) => (
              <section key={slot.replica} data-replica={slot.replica}>
                <h4 className="tb-panel__subtitle">{slot.replica}</h4>
                <pre className="tb-code" data-ok={slot.ok}>
                  {slot.text}
                </pre>
              </section>
            ))}
          </div>
        ) : (
          <pre
            className="tb-code"
            data-ok={result.ok}
            role={result.ok ? undefined : 'alert'}
            data-testid={TESTID.testbed.action.result(core, action.name)}
          >
            {result.text}
          </pre>
        ))}
    </LockAwareEditor>
  );
}

export function ActionList({
  core,
  actions,
  replicas = [],
}: {
  core: string;
  actions: readonly Action[];
  /** An external core's replica ids (empty for in-proc cores). */
  replicas?: readonly string[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = actions.filter((action) => action.surfaces.includes('ui'));
  if (shown.length === 0) return null;
  return (
    <div className="tb-actions">
      <div className="tb-actions__buttons">
        {shown.map((action) => (
          <Button
            key={action.name}
            variant={open === action.name ? 'primary' : 'secondary'}
            aria-expanded={open === action.name}
            onClick={() => setOpen(open === action.name ? null : action.name)}
            testId={TESTID.testbed.action.root(core, action.name)}
          >
            {action.title}
          </Button>
        ))}
      </div>
      {shown
        .filter((action) => action.name === open)
        .map((action) => (
          <ActionForm key={action.name} core={core} action={action} replicas={replicas} />
        ))}
    </div>
  );
}
