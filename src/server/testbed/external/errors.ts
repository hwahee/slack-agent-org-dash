/**
 * What a failed call to an external core becomes on the control plane
 * (docs/testbed/external-core-protocol.md §4.4).
 */
import { TESTBED_ERROR_STATUS, type TestbedErrorCode } from '@shared/testbed/errors';
import { ValidationError, type ValidationIssue } from '@shared/validation';

import { TestbedError } from '../errors';
import { RpcClosedError, RpcRequestError, RpcTimeoutError } from './rpc';

function issuesFrom(details: unknown, message: string): ValidationIssue[] {
  if (Array.isArray(details)) {
    const issues = details.filter(
      (issue): issue is { path?: unknown; message: string; code?: unknown } =>
        typeof issue === 'object' &&
        issue !== null &&
        typeof (issue as { message?: unknown }).message === 'string',
    );
    if (issues.length > 0) {
      return issues.map((issue) => ({
        path: typeof issue.path === 'string' ? issue.path : '',
        message: issue.message,
        code: typeof issue.code === 'string' ? issue.code : 'invalid',
      }));
    }
  }
  return [{ path: '', message, code: 'invalid' }];
}

/**
 * - the core's own control-plane code (`VALIDATION_ERROR`, `CORE_NOT_RUNNING`, …)
 *   keeps that code and its HTTP status;
 * - any other code → `CORE_ERROR` (502) with `details.coreCode`;
 * - no answer in time → `CORE_TIMEOUT` (504); the process ended → `CORE_ERROR`
 *   with `coreCode: 'EXITED'`.
 */
export function fromCoreCall(core: string, replica: string, error: unknown): Error {
  if (error instanceof RpcTimeoutError) {
    return new TestbedError(
      'CORE_TIMEOUT',
      `코어 ${core}(${replica})가 ${error.method}에 ${error.timeoutMs}ms 안에 답하지 않음. 코어 로그를 보고 다시 시도하거나 requestTimeoutMs를 늘림`,
      { core, replica, method: error.method, timeoutMs: error.timeoutMs },
    );
  }
  if (error instanceof RpcClosedError) {
    return new TestbedError(
      'CORE_ERROR',
      `코어 ${core}(${replica})의 프로세스가 ${error.method}에 답하기 전에 끝남. 감시가 다시 띄운 뒤 다시 시도`,
      { core, replica, method: error.method, coreCode: 'EXITED' },
    );
  }
  if (error instanceof RpcRequestError) {
    const data = (typeof error.data === 'object' && error.data !== null ? error.data : {}) as {
      code?: unknown;
      details?: unknown;
    };
    const code = typeof data.code === 'string' ? data.code : `RPC_${error.rpcCode}`;
    if (code === 'VALIDATION_ERROR')
      return new ValidationError(issuesFrom(data.details, error.message));
    if (code in TESTBED_ERROR_STATUS) {
      return new TestbedError(code as TestbedErrorCode, error.message, data.details);
    }
    return new TestbedError(
      'CORE_ERROR',
      `코어 ${core}(${replica}) 오류 ${code}: ${error.message}`,
      {
        core,
        replica,
        method: error.method,
        coreCode: code,
        ...(data.details === undefined ? {} : { coreDetails: data.details }),
      },
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
