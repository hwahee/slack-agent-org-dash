/**
 * Finds the scenario files: `src/server/testbed/cores/<core>/smoke/*.smoke.ts`,
 * each default-exporting `defineSmoke({...})`. Testbed repositories add them
 * under `cores/` only, so the common runtime never changes for them.
 */
import { join, relative } from 'node:path';

import type { SmokeDefinition } from './index';
import type { LoadedScenario } from './runner';

const SCENARIO_GLOB = 'src/server/testbed/cores/*/smoke/*.smoke.ts';

/** The repository root (this file is `src/server/testbed/smoke/load.ts`). */
export const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

function isDefinition(value: unknown): value is SmokeDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SmokeDefinition).name === 'string' &&
    typeof (value as SmokeDefinition).run === 'function'
  );
}

export async function loadScenarios(root = REPO_ROOT): Promise<LoadedScenario[]> {
  const files = [...new Bun.Glob(SCENARIO_GLOB).scanSync({ cwd: root, absolute: true })].sort();
  const scenarios: LoadedScenario[] = [];
  for (const path of files) {
    const module = (await import(path)) as { default?: unknown };
    const file = relative(root, path);
    if (!isDefinition(module.default)) {
      throw new Error(`${file}: default export is not defineSmoke({...})`);
    }
    scenarios.push({ definition: module.default, file });
  }
  const seen = new Map<string, string>();
  for (const { definition, file } of scenarios) {
    const other = seen.get(definition.name);
    if (other !== undefined) {
      throw new Error(`scenario name '${definition.name}' is used by ${other} and ${file}`);
    }
    seen.set(definition.name, file ?? '');
  }
  return scenarios;
}
