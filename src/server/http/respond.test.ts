/**
 * Error mapping of `apiRoute` for errors no current route throws yet (so the
 * API integration suite cannot reach them through HTTP).
 */
import { describe, expect, test } from 'bun:test';

import type { ApiErrorBody } from '@shared/api/errors';
import { s, toValidator } from '@shared/validation';

import { loadServerConfig } from '../config';
import { UnauthorizedError } from '../lib/errors';
import { silentLogger } from '../lib/log';
import { apiRoute } from './respond';

const deps = {
  config: loadServerConfig({ DB_DRIVER: 'memory' }),
  log: silentLogger,
};

/** The error `fn` throws (fails the test if it throws none). */
function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('expected fn to throw an Error');
}

async function callThrowing(error: Error, headers: Record<string, string> = {}) {
  const route = apiRoute<'/test'>({ GET: () => Promise.reject(error) }, deps);
  const req = new Request('http://localhost/test', { headers }) as Bun.BunRequest<'/test'>;
  const response = await route.GET!(req);
  return { status: response.status, body: (await response.json()) as ApiErrorBody };
}

describe('apiRoute error mapping', () => {
  test('UnauthorizedError → 401 UNAUTHORIZED with a localized message', async () => {
    const en = await callThrowing(new UnauthorizedError());
    expect(en.status).toBe(401);
    expect(en.body.error.code).toBe('UNAUTHORIZED');
    expect(en.body.error.message).toBe('Please sign in to continue.');

    const ko = await callThrowing(new UnauthorizedError(), { 'accept-language': 'ko' });
    expect(ko.body.error.message).toBe('로그인이 필요합니다.');
  });

  test('ValidationError → 400 VALIDATION_ERROR with the issues as details', async () => {
    const validator = toValidator(s.object({ title: s.string().check(s.minLength(1)) }));
    const { status, body } = await callThrowing(
      thrownBy(() => validator.parse({ title: '' })),
      { 'accept-language': 'ko' },
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('요청에 잘못된 데이터가 포함되어 있습니다.');
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  test('a malformed JSON body (SyntaxError) is a validation error, not a 500', async () => {
    const { status, body } = await callThrowing(thrownBy(() => JSON.parse('{not json')));
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
