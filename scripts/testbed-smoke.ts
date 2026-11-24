/**
 * `bun run testbed:smoke` — the MCP smoke (docs/testbed/verification.md §4).
 *
 *   bun run testbed:smoke                      # boot this repo's server on a free port
 *   bun run testbed:smoke --url <base>         # a running instance (local or a container)
 *   bun run testbed:smoke --only <name>        # one scenario (the common check still runs)
 *   bun run testbed:smoke --json <path>        # also write the results as JSON
 *
 * `TESTBED_CONTROL_TOKEN` in the env is sent as the Bearer token.
 * Exit codes: 0 all passed (skips included), 1 something failed, 2 no
 * instance to test (the server did not start, or nothing answered).
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { loadScenarios } from '../src/server/testbed/smoke/load';
import { runSmoke, SmokeConnectError } from '../src/server/testbed/smoke/runner';
import { startLocalTestbed, StartError } from '../src/server/testbed/smoke/server';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    url: { type: 'string' },
    only: { type: 'string' },
    json: { type: 'string' },
  },
});

const token =
  process.env.TESTBED_CONTROL_TOKEN === undefined || process.env.TESTBED_CONTROL_TOKEN === ''
    ? undefined
    : process.env.TESTBED_CONTROL_TOKEN;

async function main(): Promise<number> {
  let scenarios;
  try {
    scenarios = await loadScenarios();
  } catch (error) {
    console.error(
      `cannot load scenarios: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  let local: Awaited<ReturnType<typeof startLocalTestbed>> | undefined;
  let url = values.url;
  if (url === undefined) {
    try {
      local = await startLocalTestbed();
    } catch (error) {
      console.error(error instanceof StartError ? error.message : String(error));
      return 2;
    }
    url = local.url;
  }

  try {
    console.log(`smoke against ${url} (${scenarios.length} scenarios)`);
    const report = await runSmoke({
      target: { url, ...(token === undefined ? {} : { token }) },
      scenarios,
      ...(values.only === undefined ? {} : { only: values.only }),
      log: (line) => console.log(line),
    });
    const exitCode = report.ok ? 0 : 1;
    if (values.json !== undefined) {
      await writeFile(values.json, `${JSON.stringify({ ...report, exitCode }, null, 2)}\n`);
    }
    return exitCode;
  } catch (error) {
    if (error instanceof SmokeConnectError) {
      console.error(error.message);
      return 2;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await local?.stop();
  }
}

process.exit(await main());
