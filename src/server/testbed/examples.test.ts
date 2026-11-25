import { expect, test } from 'bun:test';

import { exampleCores } from './examples';

test('TESTBED_EXAMPLE_CORES names example cores; an unknown name fails the boot', () => {
  expect(exampleCores([])).toEqual([]);
  expect(exampleCores(['py-echo']).map((core) => core.id)).toEqual(['py-echo']);
  expect(() => exampleCores(['nope'])).toThrow("no example core 'nope' (known: py-echo)");
});
