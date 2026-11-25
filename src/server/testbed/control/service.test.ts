/**
 * How `testbed.control.invoked` records an operation's input and failure
 * (docs/testbed/control-plane.md §1.1).
 */
import { describe, expect, test } from 'bun:test';

import { ValidationError } from '@shared/validation';

import { NotFoundError } from '../../lib/errors';
import { TestbedError } from '../errors';
import { recordedError, recordedInput } from './service';

describe('recordedInput', () => {
  test('a short input stays a value, so the detail panel can unfold it', () => {
    const input = { core: 'sample', patch: { maxConnections: 'x' } };
    expect(recordedInput(input)).toEqual(input);
    expect(recordedInput(undefined)).toBeNull();
  });

  test('a long input is cut to a string, its secrets masked before the cut', () => {
    const input = { core: 'sample', patch: { apiToken: 'sk-very-secret', blob: 'x'.repeat(5000) } };
    const recorded = recordedInput(input);
    expect(typeof recorded).toBe('string');
    expect((recorded as string).length).toBeLessThanOrEqual(2001);
    expect(recorded as string).toEndWith('…');
    expect(recorded as string).not.toContain('sk-very-secret');
    expect(recorded as string).toContain('"apiToken":"sk-v…(len 14, sha256:');
  });
});

describe('recordedError', () => {
  test('bad input: VALIDATION_ERROR with each issue', () => {
    const issues = [{ path: 'maxConnections', message: 'Expected number', code: 'invalid_type' }];
    expect(recordedError(new ValidationError(issues))).toEqual({
      code: 'VALIDATION_ERROR',
      issues,
    });
  });

  test('testbed and not-found errors keep their code and message; anything else is INTERNAL_ERROR', () => {
    expect(recordedError(new TestbedError('RUN_ACTIVE', 'a Run is open'))).toEqual({
      code: 'RUN_ACTIVE',
      message: 'a Run is open',
    });
    expect(recordedError(new NotFoundError('core', 'nope'))).toEqual({
      code: 'NOT_FOUND',
      message: 'core not found: nope',
    });
    expect(recordedError(new Error('boom at /secret/path'))).toEqual({ code: 'INTERNAL_ERROR' });
  });
});
