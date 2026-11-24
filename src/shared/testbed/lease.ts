/**
 * The control lease as everyone may see it (docs/testbed/control-plane.md §2).
 * Ids are cut to their first 4 characters: enough to tell holders apart, not
 * enough to act as them.
 */
import type { UtcIsoString } from '@shared/time';

import type { Actor } from './events';

export interface LeaseView {
  actor: Actor;
  name?: string;
  /** First 4 characters of the MCP session id or the REST lease id. */
  holder: string;
  expiresAt: UtcIsoString;
  remainingMs: number;
}
