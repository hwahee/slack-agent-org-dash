/**
 * `bun run test:ui` — the Playwright UI tests (docs/testbed/verification.md §5).
 *
 * Boots this repo's server on a free port the same way the MCP smoke does
 * (`TESTBED_RUN_STORE=memory`, every core port at 0), runs `playwright test`
 * against it with any arguments given here, then stops the server.
 *
 *   bun run test:ui                 # all tests
 *   bun run test:ui -g "lease"      # by title
 */
import { startLocalTestbed, StartError } from '../src/server/testbed/smoke/server';

let testbed;
try {
  testbed = await startLocalTestbed();
} catch (error) {
  console.error(error instanceof StartError ? error.message : String(error));
  process.exit(2);
}

const child = Bun.spawn(['bunx', 'playwright', 'test', ...Bun.argv.slice(2)], {
  env: { ...process.env, TESTBED_UI_URL: testbed.url },
  stdout: 'inherit',
  stderr: 'inherit',
});
const code = await child.exited;
await testbed.stop();
process.exit(code);
