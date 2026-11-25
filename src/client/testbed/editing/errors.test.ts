import { describe, expect, test } from 'bun:test';

import { translate, type MessageKey, type MessageParams } from '@shared/i18n';

import { ApiRequestError } from '../../api/http';
import {
  errorLines,
  errorMessage,
  issueLines,
  issueText,
  jsonErrorText,
  type Issue,
} from './errors';

const ko = (key: MessageKey, params?: MessageParams) => translate('ko', key, params);
const en = (key: MessageKey, params?: MessageParams) => translate('en', key, params);

const invalid = (issues: Issue[]) =>
  new ApiRequestError(400, 'VALIDATION_ERROR', '요청에 잘못된 데이터가 포함되어 있습니다.', issues);

describe('validation issues in the page language', () => {
  const cases: [Issue, string, string][] = [
    [
      {
        code: 'too_small',
        message: 'Too small: expected number to be >=1',
        params: { origin: 'number', minimum: 1, inclusive: true },
      },
      '1 이상이어야 함',
      'Must be at least 1',
    ],
    [
      { code: 'too_big', params: { origin: 'number', maximum: 65535, inclusive: true } },
      '65535 이하여야 함',
      'Must be at most 65535',
    ],
    [
      { code: 'too_small', params: { origin: 'number', minimum: 0, inclusive: false } },
      '0보다 커야 함',
      'Must be greater than 0',
    ],
    [
      { code: 'too_small', params: { origin: 'string', minimum: 1, inclusive: true } },
      '비워 둘 수 없음',
      'Must not be empty',
    ],
    [
      { code: 'too_big', params: { origin: 'string', maximum: 4096, inclusive: true } },
      '4096자 이하여야 함',
      'Must be at most 4096 characters',
    ],
    [
      {
        code: 'invalid_value',
        message: 'Invalid option: expected one of "debug"|"info"',
        params: { values: ['debug', 'info'] },
      },
      'debug, info 중 하나여야 함',
      'Must be one of debug, info',
    ],
    [
      { code: 'invalid_type', params: { expected: 'string', received: 'undefined' } },
      '필수',
      'Required',
    ],
    [
      { code: 'invalid_type', params: { expected: 'int', received: 'number' } },
      '정수여야 함',
      'Must be a whole number',
    ],
    [
      { code: 'invalid_type', params: { expected: 'boolean', received: 'string' } },
      'true 또는 false여야 함',
      'Must be true or false',
    ],
    [
      { code: 'unknown_key', message: "알 수 없는 설정 키 'x'" },
      '설정에 없는 키',
      'This config has no such key',
    ],
    [{ code: 'duplicate_id' }, '같은 id의 규칙이 위에 있음', 'A rule above has the same id'],
    [{ code: 'no_effect' }, '효과나 지연 중 하나는 있어야 함', 'Pick an effect or set a delay'],
    [{ code: 'delay_range' }, '최소값이 최대값보다 큼', 'The minimum is larger than the maximum'],
    [
      { code: 'unsupported_fault' },
      '이 코어가 지원하지 않는 결함',
      'This core does not support this fault',
    ],
  ];

  test.each(cases)('%o → ko and en', (issue, korean, english) => {
    expect(issueText(issue, ko)).toBe(korean);
    expect(issueText(issue, en)).toBe(english);
  });

  test('a code it does not know keeps the server message', () => {
    expect(issueText({ code: 'custom', message: 'the core said no' }, ko)).toBe('the core said no');
    // Too little to build a sentence from: the message too.
    expect(issueText({ code: 'too_small', message: 'Too small' }, ko)).toBe('Too small');
  });

  test('lines name the field; the root and unknown keys read naturally', () => {
    const error = invalid([
      { path: 'maxConnections', code: 'too_small', params: { origin: 'number', minimum: 1 } },
      { path: 'text', code: 'too_small', params: { origin: 'string', minimum: 1 } },
      { path: '', code: 'unrecognized_keys', params: { keys: ['extra', 'more'] } },
      { path: '', code: 'invalid_type', params: { expected: 'object', received: 'number' } },
    ]);
    expect(issueLines(error, ko)).toEqual([
      'maxConnections: 1 이상이어야 함',
      'text: 비워 둘 수 없음',
      'extra: 알 수 없는 키',
      'more: 알 수 없는 키',
      '(전체): 객체({…})여야 함',
    ]);
    expect(issueLines(error, en)[0]).toBe('maxConnections: Must be at least 1');
  });

  test('a failure without issues is one sentence', () => {
    const error = new ApiRequestError(500, 'INTERNAL_ERROR', 'boom');
    expect(errorLines(error, ko)).toEqual(['boom']);
    expect(errorMessage(invalid([{ path: 'a', code: 'no_effect' }]), ko)).toBe(
      'a: 효과나 지연 중 하나는 있어야 함',
    );
  });
});

describe('JSON that does not parse', () => {
  const text = '{\n  "a": 1,\n  b: 2\n}';

  test('V8 and Firefox positions become line and column', () => {
    const v8 = new SyntaxError(
      'Expected double-quoted property name in JSON at position 14 (line 3 column 3)',
    );
    expect(jsonErrorText(v8, text, ko)).toBe('JSON이 아님: 3번째 줄 3번째 칸 근처');
    const firefox = new SyntaxError(
      'JSON.parse: expected double-quoted property name at line 3 column 3 of the JSON data',
    );
    expect(jsonErrorText(firefox, text, en)).toBe('Not valid JSON near line 3, column 3.');
    const oldV8 = new SyntaxError('Unexpected token b in JSON at position 14');
    expect(jsonErrorText(oldV8, text, ko)).toBe('JSON이 아님: 3번째 줄 3번째 칸 근처');
  });

  test('without a position, a hint instead of the engine sentence', () => {
    let error: unknown;
    try {
      JSON.parse('{');
    } catch (caught) {
      error = caught;
    }
    const sentence = jsonErrorText(error, '{', ko);
    expect(sentence.startsWith('JSON이 아님')).toBe(true);
    expect(sentence).not.toContain('Parse');
  });
});
