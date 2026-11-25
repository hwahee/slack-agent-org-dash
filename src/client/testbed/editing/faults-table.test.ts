import { describe, expect, test } from 'bun:test';

import type { FaultRule } from '@shared/testbed/faults';

import { emptyRow, issueCell, moveRow, rowsToRules, rulesToRows } from './faults-table';

const rules: FaultRule[] = [
  { id: 'f1', match: { connId: 'c-1' }, delayMs: 200 },
  { id: 'f2', probability: 0.5, delayMs: { min: 100, max: 300 }, disconnect: true, times: 2 },
  { id: 'f3', corrupt: true },
  { id: 'f4', match: { status: 500, path: '42', flag: true, note: 'a,b' }, error: 'http-500' },
  { id: 'f5' },
];

describe('fault rules ↔ table', () => {
  test('the table shows each rule as text cells', () => {
    expect(rulesToRows(rules)).toEqual([
      {
        id: 'f1',
        match: 'connId=c-1',
        probability: '',
        delayMs: '200',
        effect: '',
        error: '',
        times: '',
      },
      {
        id: 'f2',
        match: '',
        probability: '0.5',
        delayMs: '100-300',
        effect: 'disconnect',
        error: '',
        times: '2',
      },
      {
        id: 'f3',
        match: '',
        probability: '',
        delayMs: '',
        effect: 'corrupt',
        error: '',
        times: '',
      },
      {
        id: 'f4',
        match: 'status=500, path="42", flag=true, note="a,b"',
        probability: '',
        delayMs: '',
        effect: 'error',
        error: 'http-500',
        times: '',
      },
      emptyRow('f5'),
    ]);
  });

  test('round trip: rules → rows → the same rules', () => {
    const working = rules.filter((rule) => rule.id !== 'f5');
    expect(rowsToRules(rulesToRows(working))).toEqual({ rules: working, errors: [] });
  });

  test('a rule with neither an effect nor a delay is reported on its effect cell', () => {
    const { errors } = rowsToRules([emptyRow('f5')]);
    expect(errors).toEqual([{ row: 0, column: 'effect', problem: 'testbed.issue.noEffect' }]);
  });

  test('cells it cannot read are reported by row and column', () => {
    const { errors } = rowsToRules([
      { ...emptyRow(''), match: 'broken', probability: '2', delayMs: 'soon', times: '0' },
      { ...emptyRow('f2'), effect: 'error' },
    ]);
    expect(errors).toEqual([
      { row: 0, column: 'id', problem: 'testbed.issue.required' },
      { row: 0, column: 'match', problem: 'testbed.issue.notKeyValue', params: { pair: 'broken' } },
      { row: 0, column: 'probability', problem: 'testbed.issue.probability' },
      { row: 0, column: 'delayMs', problem: 'testbed.issue.delay' },
      { row: 0, column: 'times', problem: 'testbed.issue.times' },
      { row: 1, column: 'error', problem: 'testbed.issue.required' },
    ]);
  });

  test('a repeated id is reported on the later row', () => {
    const { errors } = rowsToRules([
      { ...emptyRow('f1'), effect: 'disconnect' },
      { ...emptyRow(' f1 '), effect: 'corrupt' },
    ]);
    expect(errors).toEqual([{ row: 1, column: 'id', problem: 'testbed.issue.duplicateId' }]);
  });

  test('a delay range that runs backwards is reported on its cell', () => {
    const { errors } = rowsToRules([{ ...emptyRow('f1'), delayMs: '300-100' }]);
    expect(errors).toEqual([{ row: 0, column: 'delayMs', problem: 'testbed.issue.delayRange' }]);
  });

  test('a server issue lands on the cell its path names', () => {
    expect(issueCell('faults.2.times')).toEqual({ row: 2, column: 'times' });
    expect(issueCell('faults.0.match.connId')).toEqual({ row: 0, column: 'match' });
    expect(issueCell('faults.1.delayMs.min')).toEqual({ row: 1, column: 'delayMs' });
    // A whole rule (no effect, unsupported fault) or its flag: the effect cell.
    expect(issueCell('faults.1')).toEqual({ row: 1, column: 'effect' });
    expect(issueCell('faults.1.disconnect')).toEqual({ row: 1, column: 'effect' });
    expect(issueCell('maxConnections')).toBeNull();
  });

  test('rows move up and down within bounds', () => {
    expect(moveRow(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveRow(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveRow(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });
});
