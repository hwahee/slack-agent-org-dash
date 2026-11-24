/**
 * Every core's dashboard module (panel slots, src/client/testbed/registry.ts).
 * A testbed adds `import { xCore } from './x';` and lists it here. The sample
 * core has no panels of its own: the common components cover it.
 */
import type { ClientCoreModule } from '../registry';

export const CLIENT_CORES: readonly ClientCoreModule[] = [];
