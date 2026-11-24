/**
 * The cores this testbed runs. A testbed repository lists its own cores here
 * (this file is under `cores/`, so it is the testbed's to edit).
 */
import type { CoreDefinition } from '../core';
import { sampleCore } from './sample';

export const CORES: readonly CoreDefinition[] = [sampleCore];
