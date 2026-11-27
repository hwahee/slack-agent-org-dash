/**
 * What this testbed shows as a whole (docs/spec.md §11 M1 4) and the lint rule
 * that keeps the agent core read only (§11 M1 3).
 */
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

import packageJson from '../../../../../package.json';
import { createTestControlPlane } from '../../testing';
import { CORES } from '..';

describe('manifest', () => {
  test('only the agent core: no sample core, no data-plane address, no fault kinds', async () => {
    const { runtime, plane } = await createTestControlPlane({
      cores: CORES,
      env: { AGENT_DATA_DIR: '/nonexistent-agent-data' },
    });
    try {
      const manifest = plane.control.getManifest({ actor: 'ci' });
      expect(manifest.name).toBe(packageJson.name);
      expect(manifest.name).toBe('slack-agent-org-dash');
      expect(manifest.cores.map((core) => core.id)).toEqual(['agent']);
      expect(manifest.cores[0]).toMatchObject({ kind: 'passive', endpoints: [], faults: [] });
    } finally {
      await runtime.host.stopAll();
      await plane.dispose();
    }
  });
});

const root = join(import.meta.dir, '../../../../..');
const eslint = new ESLint({ cwd: root, overrideConfig: [tseslint.configs.disableTypeChecked] });

async function ruleIds(code: string, file = 'src/server/testbed/cores/agent/probe.ts') {
  const [result] = await eslint.lintText(code, { filePath: join(root, file) });
  return result?.messages.map((message) => message.ruleId) ?? [];
}

describe('read only, by lint', () => {
  test.each([
    [
      "import { writeFile } from 'node:fs/promises';\nexport const w = writeFile;\n",
      'no-restricted-imports',
    ],
    ["import { rm } from 'fs/promises';\nexport const r = rm;\n", 'no-restricted-imports'],
    [
      "import { rename } from 'node:fs/promises';\nexport const r = rename;\n",
      'no-restricted-imports',
    ],
    [
      "import { writeFileSync } from 'node:fs';\nexport const w = writeFileSync;\n",
      'no-restricted-imports',
    ],
    [
      "import { spawn } from 'node:child_process';\nexport const s = spawn;\n",
      'no-restricted-imports',
    ],
    ["export const w = () => Bun.write('x', 'y');\n", 'no-restricted-properties'],
    ["export const s = () => Bun.spawn(['ls']);\n", 'no-restricted-properties'],
    ['export const roll = Math.random();\n', 'no-restricted-properties'],
  ])('%p fails lint under cores/agent', async (code, rule) => {
    expect(await ruleIds(code)).toContain(rule);
  });

  test('reading is allowed', async () => {
    expect(
      await ruleIds(
        "import { open, readdir, readFile, stat } from 'node:fs/promises';\nexport const r = [open, readdir, readFile, stat];\n",
      ),
    ).toEqual([]);
  });

  test('the validation facade rule still holds there', async () => {
    expect(await ruleIds("import { z } from 'zod';\nexport const x = z;\n")).toContain(
      'no-restricted-imports',
    );
  });
});
