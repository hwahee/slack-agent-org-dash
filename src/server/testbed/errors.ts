/**
 * Errors of the common runtime that callers branch on by `code`
 * (docs/testbed/control-plane.md §3). The REST adapter maps them to HTTP.
 */
export type TestbedErrorCode = 'CURSOR_STALE' | 'RUN_ACTIVE';

export class TestbedError extends Error {
  override readonly name = 'TestbedError';

  constructor(
    readonly code: TestbedErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
