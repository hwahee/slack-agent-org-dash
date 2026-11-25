/**
 * `py-echo`: the Python reference core (docs/spec.md §11 M13). Turned on with
 * `TESTBED_EXAMPLE_CORES=py-echo`; needs `python3` (3.11 or newer) on `PATH`.
 */
import { defineExternalCore } from '../../src/server/testbed/external/define';

export const pyEchoCore = defineExternalCore({
  id: 'py-echo',
  kind: 'passive',
  title: 'TCP echo (Python example)',
  command: ['python3', '-u', 'examples/python-core/echo_core.py'],
});
