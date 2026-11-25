/**
 * Bun tests that need `python3` (3.11 or newer): skipped, with the reason
 * printed, when it is missing — unless `TESTBED_REQUIRE_PYTHON=1`, which
 * makes them fail instead (CI sets it).
 */
import { describe, test } from 'bun:test';

import { missingPython } from './python-check';

const missing = missingPython();

/** `describe` for tests that run Python. */
export function describePython(name: string, body: () => void): void {
  if (missing === undefined) {
    describe(name, body);
  } else if (process.env.TESTBED_REQUIRE_PYTHON === '1') {
    describe(name, () => {
      test('python3 3.11+ is available (TESTBED_REQUIRE_PYTHON=1)', () => {
        throw new Error(missing);
      });
    });
  } else {
    console.warn(`skipping "${name}": ${missing} (TESTBED_REQUIRE_PYTHON=1 makes this a failure)`);
    describe.skip(name, body);
  }
}
