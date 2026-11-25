/** The badge tone for a core or replica state. */
export const STATE_TONE = {
  running: 'success',
  error: 'danger',
  starting: 'warning',
  stopping: 'warning',
  idle: 'neutral',
  stopped: 'neutral',
} as const;
