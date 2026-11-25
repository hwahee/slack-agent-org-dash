/**
 * Bun tests that need `python3` (3.11 or newer): skipped, with the reason
 * printed, when it is missing — unless `TESTBED_REQUIRE_PYTHON=1`, which
 * makes them fail instead (CI sets it).
 */
import { describe, test } from 'bun:test';

const MIN = [3, 11] as const;

/** Why Python cannot be used here, or `undefined` when it can. */
function missingPython(): string | undefined {
  try {
    const probe = Bun.spawnSync([
      'python3',
      '-c',
      'import sys; print("%d.%d" % sys.version_info[:2])',
    ]);
    if (probe.exitCode !== 0) return `python3 exited with ${probe.exitCode}`;
    const version = probe.stdout.toString().trim();
    const [major = 0, minor = 0] = version.split('.').map(Number);
    if (major < MIN[0] || (major === MIN[0] && minor < MIN[1])) {
      return `python3 is ${version}, ${MIN.join('.')} or newer is needed`;
    }
    return undefined;
  } catch {
    return 'python3 is not on PATH';
  }
}

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
