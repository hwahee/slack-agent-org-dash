/**
 * Runs the smoke against one instance: the common check, then every scenario
 * in name order, then action coverage (docs/testbed/verification.md §4).
 */
import { COMMON_TOOLS, commonCheck } from './common';
import {
  cleanUp,
  createContext,
  restCall,
  ScenarioState,
  SmokeFailure,
  type SmokeTarget,
} from './context';
import type { SmokeDefinition, SmokeManifest } from './index';

const DEFAULT_SCENARIO_TIMEOUT_MS = 60_000;

type SmokeStatus = 'PASS' | 'FAIL' | 'SKIP';

interface ScenarioResult {
  name: string;
  title: string;
  spec: string;
  file?: string;
  status: SmokeStatus;
  durationMs: number;
  /** FAIL: the step that failed and why. */
  step?: string;
  message?: string;
  /** SKIP: why. */
  reason?: string;
}

export interface SmokeReport {
  url: string;
  instanceId: string;
  common: ScenarioResult;
  scenarios: ScenarioResult[];
  coverage: {
    status: SmokeStatus;
    /** MCP action tools the manifest exposes. */
    actions: string[];
    missing: string[];
    reason?: string;
  };
  /** Everything passed or was skipped. */
  ok: boolean;
}

export interface LoadedScenario {
  definition: SmokeDefinition;
  file?: string;
}

/** The instance did not answer (exit code 2). */
export class SmokeConnectError extends Error {
  override readonly name = 'SmokeConnectError';
}

/** `<core>_<action>` for every action exposed over MCP. */
function actionTools(manifest: SmokeManifest): string[] {
  return manifest.cores.flatMap((core) =>
    core.actions
      .filter((action) => action.surfaces.includes('mcp'))
      .map((action) => `${core.id.replaceAll('-', '_')}_${action.name}`),
  );
}

async function fetchManifest(target: SmokeTarget): Promise<SmokeManifest> {
  let response: { status: number; body: SmokeManifest };
  try {
    response = await restCall<SmokeManifest>(target, 'GET', '/manifest', { actor: 'ci' });
  } catch (error) {
    throw new SmokeConnectError(
      `no testbed at ${target.url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status !== 200) {
    throw new SmokeConnectError(`GET /testbed/api/manifest → HTTP ${response.status}`);
  }
  return response.body;
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** One report line. */
function formatResult(result: ScenarioResult): string {
  const head = `${result.status} ${result.name} (${seconds(result.durationMs)})`;
  if (result.status === 'FAIL') return `${head} at ${result.step ?? '?'}: ${result.message ?? ''}`;
  if (result.status === 'SKIP') return `${head} — ${result.reason ?? ''}`;
  return head;
}

/**
 * Runs one scenario with a fresh manifest: data-plane ports opened at 0
 * change whenever a core restarts.
 */
async function runOne(
  target: SmokeTarget,
  scenario: LoadedScenario,
): Promise<{ result: ScenarioResult; called: Set<string> }> {
  const { definition, file } = scenario;
  const manifest = await fetchManifest(target);
  const base = {
    name: definition.name,
    title: definition.title,
    spec: definition.spec,
    ...(file === undefined ? {} : { file }),
  };
  const missing = (definition.requires?.cores ?? []).filter(
    (core) => !manifest.cores.some((entry) => entry.id === core),
  );
  if (missing.length > 0) {
    return {
      result: {
        ...base,
        status: 'SKIP',
        durationMs: 0,
        reason: `requires core ${missing.join(', ')}`,
      },
      called: new Set(),
    };
  }

  const state = new ScenarioState(target, definition.name);
  const started = performance.now();
  const timeoutMs = definition.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: SmokeFailure | undefined;
  try {
    const running = (async () => {
      const t = await state.at('open MCP session', () => createContext(state, manifest));
      await definition.run(t);
    })();
    // After a timeout the scenario keeps going until cleanup closes its sessions.
    running.catch(() => undefined);
    await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new SmokeFailure(state.step, `timed out after ${seconds(timeoutMs)}`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    failure =
      error instanceof SmokeFailure
        ? error
        : new SmokeFailure(state.step, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    await cleanUp(state);
  }
  const durationMs = Math.round(performance.now() - started);
  return {
    result: failure
      ? { ...base, status: 'FAIL', durationMs, step: failure.step, message: failure.message }
      : { ...base, status: 'PASS', durationMs },
    called: state.called,
  };
}

export async function runSmoke(options: {
  target: SmokeTarget;
  scenarios: readonly LoadedScenario[];
  /** Only this scenario (the common check still runs; coverage is skipped). */
  only?: string;
  /** Each report line as it is ready. */
  log?: (line: string) => void;
}): Promise<SmokeReport> {
  const { target, only } = options;
  const log = options.log ?? (() => undefined);
  const manifest = await fetchManifest(target);

  const common = await runOne(target, { definition: commonCheck });
  const uncalled = COMMON_TOOLS.filter((tool) => !common.called.has(tool));
  if (common.result.status === 'PASS' && uncalled.length > 0) {
    common.result = {
      ...common.result,
      status: 'FAIL',
      step: 'common tools',
      message: `not called: ${uncalled.join(', ')}`,
    };
  }
  log(formatResult(common.result));

  const selected = options.scenarios
    .filter((scenario) => only === undefined || scenario.definition.name === only)
    .toSorted((a, b) => a.definition.name.localeCompare(b.definition.name));
  if (only !== undefined && selected.length === 0) {
    throw new Error(`no scenario named ${only}`);
  }

  const scenarios: ScenarioResult[] = [];
  const called = new Set<string>();
  for (const scenario of selected) {
    const outcome = await runOne(target, scenario);
    if (outcome.result.status !== 'SKIP') for (const tool of outcome.called) called.add(tool);
    scenarios.push(outcome.result);
    log(formatResult(outcome.result));
  }

  const actions = actionTools(manifest);
  const missing = actions.filter((tool) => !called.has(tool));
  const coverage: SmokeReport['coverage'] =
    only === undefined
      ? { status: missing.length === 0 ? 'PASS' : 'FAIL', actions, missing }
      : { status: 'SKIP', actions, missing, reason: '--only' };
  log(
    coverage.status === 'SKIP'
      ? `SKIP coverage — ${coverage.reason ?? ''}`
      : coverage.status === 'PASS'
        ? `PASS coverage (${actions.length > 0 ? actions.join(', ') : 'no actions'})`
        : `FAIL coverage — not called by any scenario: ${missing.join(', ')}`,
  );

  const all = [common.result, ...scenarios];
  const count = (status: SmokeStatus) => all.filter((result) => result.status === status).length;
  log(
    `total: ${count('PASS')} pass, ${count('FAIL')} fail, ${count('SKIP')} skip; coverage ${coverage.status}`,
  );
  return {
    url: target.url,
    instanceId: manifest.instanceId,
    common: common.result,
    scenarios,
    coverage,
    ok: count('FAIL') === 0 && coverage.status !== 'FAIL',
  };
}
