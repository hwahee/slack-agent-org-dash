/**
 * Error codes of the testbed control plane (docs/testbed/control-plane.md §3),
 * on top of the boilerplate's envelope codes. REST answers with
 * `{ error: { code, message, details? } }` like every other endpoint.
 */
export type TestbedErrorCode =
  | 'CURSOR_STALE'
  | 'RUN_ACTIVE'
  | 'CORE_NOT_RUNNING'
  | 'LOCKED'
  | 'LEASE_HELD'
  | 'RESTART_REQUIRED'
  | 'CORE_ERROR'
  | 'CORE_TIMEOUT';

/** HTTP status for each code. */
export const TESTBED_ERROR_STATUS: Record<TestbedErrorCode, number> = {
  LOCKED: 423,
  LEASE_HELD: 409,
  RUN_ACTIVE: 409,
  CORE_NOT_RUNNING: 409,
  RESTART_REQUIRED: 409,
  CURSOR_STALE: 410,
  /** An external core answered with an error of its own (`details.coreCode`). */
  CORE_ERROR: 502,
  /** An external core did not answer within `requestTimeoutMs`. */
  CORE_TIMEOUT: 504,
};
