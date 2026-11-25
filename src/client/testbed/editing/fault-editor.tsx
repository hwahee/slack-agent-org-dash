/**
 * The fault rules of a core's config as a table (docs/testbed/dashboard.md
 * §1): id, match, probability, delay, effect, times. Rows can be added,
 * removed and reordered; the effect offers only the kinds the core declares.
 * Saving is a config patch `{ faults: [...] }`.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { MessageKey } from '@shared/i18n';
import type { FaultKind } from '@shared/testbed/core';
import type { FaultRule } from '@shared/testbed/faults';

import { testbedApi } from '../../api/endpoints';
import { useI18n } from '../../i18n/locale-context';
import { TESTID } from '../../testing/testids';
import { Button } from '../../ui/button';
import { Select } from '../../ui/select';
import { TextField } from '../../ui/text-field';
import { configQueryKey } from './config-editor';
import { errorMessage, issueLines } from './errors';
import {
  emptyRow,
  moveRow,
  rowsToRules,
  rulesToRows,
  type FaultCellError,
  type FaultEffect,
  type FaultRow,
} from './faults-table';
import { LockAwareEditor } from './lock-aware-editor';
import { OperateButton } from './operate-button';
import { useLockAwareEditor } from './use-lock-aware-editor';

const TEXT_COLUMNS = ['id', 'match', 'probability', 'delayMs', 'times'] as const;
/** The accepted format goes under the input, so every label stays one short line. */
const HINTS: Partial<Record<(typeof TEXT_COLUMNS)[number], MessageKey>> = {
  match: 'testbed.faults.hint.match',
  probability: 'testbed.faults.hint.probability',
  delayMs: 'testbed.faults.hint.delayMs',
};

function rulesOf(config: Record<string, unknown> | undefined): FaultRule[] | undefined {
  if (!config) return undefined;
  return Array.isArray(config.faults) ? (config.faults as FaultRule[]) : [];
}

export function FaultEditor({ core, kinds }: { core: string; kinds: readonly FaultKind[] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: configQueryKey(core),
    queryFn: () => testbedApi.config(core),
  });
  const [cellErrors, setCellErrors] = useState<FaultCellError[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const editor = useLockAwareEditor<FaultRow[], FaultRule[]>({
    server: rulesOf(config.data),
    toDraft: rulesToRows,
    refetch: async () => rulesOf((await config.refetch()).data),
  });
  const rows = editor.value ?? [];
  const readOnly = editor.readOnly;
  const canDelay = kinds.includes('delay');
  const effects: FaultEffect[] = ['', ...kinds.filter((kind) => kind !== 'delay')];

  const change = (next: FaultRow[]) => {
    setSaved(false);
    editor.edit(next);
  };
  const setCell = (index: number, column: keyof FaultRow, value: string) =>
    change(rows.map((row, at) => (at === index ? { ...row, [column]: value } : row)));
  const cellError = (index: number, column: keyof FaultRow) =>
    cellErrors.find((error) => error.row === index && error.column === column)?.message;

  async function save() {
    const { rules, errors } = rowsToRules(rows);
    setCellErrors(errors);
    setProblems([]);
    if (errors.length > 0) return;
    const outcome = await editor.save(() => testbedApi.setConfig(core, { faults: rules }));
    if (outcome.ok) {
      queryClient.setQueryData(configQueryKey(core), outcome.result.config);
      setSaved(true);
      return;
    }
    const lines = issueLines(outcome.error);
    setProblems(lines.length > 0 ? lines : [errorMessage(outcome.error)]);
  }

  return (
    <LockAwareEditor
      editor={editor}
      draftText={(draft) => JSON.stringify(rowsToRules(draft).rules, null, 2)}
    >
      <div className="tb-faults" data-testid={TESTID.testbed.faults.root(core)}>
        {rows.length === 0 && <p className="muted">{t('testbed.faults.none')}</p>}
        {rows.map((row, index) => (
          <fieldset
            key={index}
            className="tb-faults__row"
            data-testid={TESTID.testbed.faults.row(core, index)}
          >
            <legend className="visually-hidden">
              {t('testbed.faults.rule', { n: index + 1 })}
            </legend>
            {TEXT_COLUMNS.filter((column) => column !== 'delayMs' || canDelay).map((column) => {
              const error = cellError(index, column);
              const hint = HINTS[column];
              return (
                <TextField
                  key={column}
                  label={t(`testbed.faults.column.${column}`)}
                  {...(hint === undefined ? {} : { hint: t(hint) })}
                  value={row[column]}
                  readOnly={readOnly}
                  {...(error === undefined ? {} : { error })}
                  onChange={(event) => setCell(index, column, event.target.value)}
                  testId={TESTID.testbed.faults.cell(core, index, column)}
                />
              );
            })}
            <Select
              label={t('testbed.faults.column.effect')}
              value={row.effect}
              options={effects.map((effect) => ({
                value: effect,
                label: effect === '' ? '—' : effect,
              }))}
              disabled={readOnly}
              onChange={(effect) => setCell(index, 'effect', effect)}
              testId={TESTID.testbed.faults.cell(core, index, 'effect')}
            />
            {row.effect === 'error' && (
              <TextField
                label={t('testbed.faults.column.error')}
                value={row.error}
                readOnly={readOnly}
                {...(cellError(index, 'error') === undefined
                  ? {}
                  : { error: cellError(index, 'error') })}
                onChange={(event) => setCell(index, 'error', event.target.value)}
                testId={TESTID.testbed.faults.cell(core, index, 'error')}
              />
            )}
            <div className="tb-faults__row-actions">
              <Button
                variant="ghost"
                aria-label={t('testbed.faults.up')}
                disabled={readOnly || index === 0}
                onClick={() => change(moveRow(rows, index, -1))}
                testId={TESTID.testbed.faults.up(core, index)}
              >
                <ArrowUp aria-hidden size="1em" />
              </Button>
              <Button
                variant="ghost"
                aria-label={t('testbed.faults.down')}
                disabled={readOnly || index === rows.length - 1}
                onClick={() => change(moveRow(rows, index, 1))}
                testId={TESTID.testbed.faults.down(core, index)}
              >
                <ArrowDown aria-hidden size="1em" />
              </Button>
              <Button
                variant="ghost"
                aria-label={t('testbed.faults.remove')}
                disabled={readOnly}
                onClick={() => change(rows.filter((_, at) => at !== index))}
                testId={TESTID.testbed.faults.remove(core, index)}
              >
                <Trash2 aria-hidden size="1em" />
              </Button>
            </div>
          </fieldset>
        ))}
        <div className="tb-faults__actions">
          <Button
            variant="secondary"
            disabled={readOnly}
            onClick={() => {
              const ids = new Set(rows.map((row) => row.id));
              let n = rows.length + 1;
              while (ids.has(`f${n}`)) n += 1;
              change([...rows, emptyRow(`f${n}`)]);
            }}
            testId={TESTID.testbed.faults.add(core)}
          >
            <Plus aria-hidden size="1em" />
            {t('testbed.faults.add')}
          </Button>
          <OperateButton onClick={() => void save()} testId={TESTID.testbed.faults.save(core)}>
            {t('testbed.faults.save')}
          </OperateButton>
          {saved && <span role="status">{t('testbed.faults.saved')}</span>}
        </div>
        {problems.length > 0 && (
          <ul className="tb-editor__problems" role="alert">
            {problems.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </div>
    </LockAwareEditor>
  );
}
