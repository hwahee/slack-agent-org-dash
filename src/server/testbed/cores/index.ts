/**
 * The cores this testbed runs. A testbed repository lists its own cores here
 * (this file is under `cores/`, so it is the testbed's to edit).
 *
 * The sample core is not registered here (docs/spec.md §2): its files stay
 * under `cores/sample/` only because the common runtime's tests import it.
 */
import type { AnyCoreDefinition } from '../core-host';
import { agentCore } from './agent';

export const CORES: readonly AnyCoreDefinition[] = [agentCore];
