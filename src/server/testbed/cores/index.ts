/**
 * The cores this testbed runs. A testbed repository lists its own cores here
 * (this file is under `cores/`, so it is the testbed's to edit).
 */
import type { AnyCoreDefinition } from '../core-host';
import { sampleCore } from './sample';

export const CORES: readonly AnyCoreDefinition[] = [sampleCore];
