import { describe, expect, test } from 'bun:test';

import type { FaultRule } from '@shared/testbed/faults';

import { emptyRow, moveRow, rowsToRules, rulesToRows } from './faults-table';

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
    expect(rowsToRules(rulesToRows(rules))).toEqual({ rules, errors: [] });
  });

  test('cells it cannot read are reported by row and column', () => {
    const { errors } = rowsToRules([
      { ...emptyRow(''), match: 'broken', probability: '2', delayMs: 'soon', times: '0' },
      { ...emptyRow('f2'), effect: 'error' },
    ]);
    expect(errors).toEqual([
      { row: 0, column: 'id', message: 'required' },
      { row: 0, column: 'match', message: '"broken" is not key=value' },
      { row: 0, column: 'probability', message: '0–1' },
      { row: 0, column: 'delayMs', message: 'ms or min-max' },
      { row: 0, column: 'times', message: 'integer ≥ 1' },
      { row: 1, column: 'error', message: 'required' },
    ]);
  });

  test('rows move up and down within bounds', () => {
    expect(moveRow(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveRow(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveRow(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });
});
