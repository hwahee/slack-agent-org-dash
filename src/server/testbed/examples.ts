/**
 * The example cores under `examples/` (docs/testbed/architecture.md §7). None
 * runs unless `TESTBED_EXAMPLE_CORES` names it, so the default image and the
 * default run stay as they are.
 */
import { pyEchoCore } from '../../../examples/python-core';
import type { AnyCoreDefinition } from './core-host';

export const EXAMPLE_CORES: readonly AnyCoreDefinition[] = [pyEchoCore];

/** The example cores `TESTBED_EXAMPLE_CORES` names, in its order; an unknown name throws. */
export function exampleCores(names: readonly string[]): AnyCoreDefinition[] {
  return names.map((name) => {
    const core = EXAMPLE_CORES.find((example) => example.id === name);
    if (!core) {
      const known = EXAMPLE_CORES.map((example) => example.id).join(', ');
      throw new Error(`TESTBED_EXAMPLE_CORES: no example core '${name}' (known: ${known})`);
    }
    return core;
  });
}
