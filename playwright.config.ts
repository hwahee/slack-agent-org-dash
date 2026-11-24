/**
 * UI automation (docs/testbed/verification.md §5). Run it with
 * `bun run test:ui`, which boots the server on a free port and passes its
 * address in `TESTBED_UI_URL`. The tests share that one instance, so they
 * run one at a time and reset it before each test.
 */
import { defineConfig, devices } from '@playwright/test';

/** Set by `bun run test:ui`; the helpers refuse to run without it. */
const baseURL = process.env.TESTBED_UI_URL;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...(baseURL === undefined ? {} : { baseURL }),
    locale: 'en-US',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
});
