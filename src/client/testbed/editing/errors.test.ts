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
import { localTime } from '../views/event-display';

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

describe("control-plane errors in the dashboard's words", () => {
  const fail = (status: number, code: string, message: string, details: unknown) =>
    new ApiRequestError(status, code as 'UNKNOWN', message, details);

  test('RUN_ACTIVE names the checkbox and the local time, not start_run or UTC', () => {
    const startedAt = '2026-11-25T01:45:12.345Z';
    const error = fail(
      409,
      'RUN_ACTIVE',
      "Run이 이미 열려 있음(run-1-ab, 'load', human이 01:45에 엶). 닫고 새로 시작하려면 start_run에 endActive: true",
      { runId: 'run-1-ab', label: 'load', openedBy: { actor: 'human' }, startedAt },
    );
    const time = localTime(startedAt).slice(0, 8);
    expect(errorMessage(error, ko)).toBe(
      `Run 'load'이(가) 이미 열려 있음(human이(가) ${time}에 엶). 닫고 새로 시작하려면 '열린 Run을 닫고 시작'을 체크하고 다시 시작`,
    );
    expect(errorMessage(error, en)).toContain('tick “End the open Run first”');
    expect(errorMessage(error, en)).not.toContain('endActive');
  });

  test('CORE_NOT_RUNNING names the Start button as the card shows it', () => {
    const error = fail(409, 'CORE_NOT_RUNNING', '… start 후 다시 시도', {
      core: 'sample',
      state: 'stopped',
    });
    expect(errorMessage(error, ko)).toBe(
      "코어 sample가 running이 아니라 stopped 상태임. 코어 카드에서 '시작'을 누른 뒤 다시 시도",
    );
    expect(errorMessage(error, en)).toBe(
      'Core sample is stopped, not running. Press “Start” on its card, then try again.',
    );
    const replica = fail(409, 'CORE_NOT_RUNNING', '…', {
      core: 'py-echo',
      replica: 'r1',
      state: 'starting',
    });
    expect(errorMessage(replica, en)).toStartWith('Core py-echo r1 is starting');
  });

  test('LOCKED reads like the lease banner', () => {
    const error = fail(423, 'LOCKED', '…', {
      holder: { actor: 'agent', name: 'claude-code', holder: 'ab12', remainingMs: 521_000 },
      remainingMs: 521_000,
    });
    expect(errorMessage(error, ko)).toStartWith(
      'claude-code가 제어 중이라 조작할 수 없음 · 세션 ab12 · 남은 시간 08:41',
    );
  });

  test('RESTART_REQUIRED, NOT_FOUND and external core failures', () => {
    expect(
      errorMessage(
        fail(409, 'RESTART_REQUIRED', '… set_config 후 stop → start', { core: 'sample' }),
        en,
      ),
    ).toBe(
      'The sample settings for this Run apply only after a restart. Save them in the config, press “Stop” then “Start”, and start the Run.',
    );
    expect(
      errorMessage(fail(404, 'NOT_FOUND', 'not found', { resource: 'run', id: 'current' }), ko),
    ).toBe('열린 Run이 없음');
    expect(
      errorMessage(fail(404, 'NOT_FOUND', 'not found', { resource: 'action', id: 'sample.x' }), en),
    ).toBe("No action 'sample.x' was found.");
    expect(
      errorMessage(
        fail(502, 'CORE_ERROR', '코어 py-echo(r0) 오류 BUSY: queue is full', {
          core: 'py-echo',
          replica: 'r0',
          coreCode: 'BUSY',
        }),
        en,
      ),
    ).toBe('Core py-echo r0 answered with error BUSY: queue is full');
    expect(
      errorMessage(
        fail(502, 'CORE_ERROR', '…', { core: 'py-echo', replica: 'r0', coreCode: 'EXITED' }),
        ko,
      ),
    ).toBe('코어 py-echo r0의 프로세스가 답하기 전에 끝남. 다시 뜨면 다시 시도');
    expect(
      errorMessage(
        fail(504, 'CORE_TIMEOUT', '…', { core: 'py-echo', replica: 'r0', timeoutMs: 5000 }),
        ko,
      ),
    ).toBe('코어 py-echo r0가 5000ms 안에 답하지 않음. 로그를 보고 다시 시도');
  });

  test('codes it does not know, or without the details, keep the server sentence', () => {
    expect(errorMessage(fail(500, 'INTERNAL_ERROR', '예기치 않은 오류', undefined), ko)).toBe(
      '예기치 않은 오류',
    );
    expect(errorMessage(fail(409, 'RUN_ACTIVE', 'server words', {}), ko)).toBe('server words');
  });
});
