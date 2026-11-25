/**
 * Puts the common runtime together for one boot: event bus, Run store and
 * manager, and the core host with this testbed's cores registered.
 */
import { APP_VERSION } from '@shared/api/version';

import packageJson from '../../../package.json';
import type { ServerConfig } from '../config';
import type { Logger } from '../lib/log';
import type { TestbedConfig } from './config';
import { LeaseManager } from './control/lease';
import { ControlService } from './control/service';
import { CoreHost, type AnyCoreDefinition } from './core-host';
import { EventBus } from './events/bus';
import type { TestbedHttp } from './http/routes';
import { TestbedSocketHub } from './http/ws';
import { McpEndpoint } from './mcp/endpoint';
import { openFileRunStore } from './runs/file-store';
import { createMemoryRunStore } from './runs/memory-store';
import { RunManager } from './runs/runs';
import type { RunStore } from './runs/store';
import { TESTBED_BASE_VERSION } from './version';

export interface TestbedRuntime {
  bus: EventBus;
  store: RunStore;
  runs: RunManager;
  host: CoreHost;
}

export async function createTestbedRuntime(options: {
  config: TestbedConfig;
  env: Record<string, string | undefined>;
  log: Logger;
  cores: readonly AnyCoreDefinition[];
  /** External cores' working directory (the repository root). */
  cwd?: string;
  /** External cores' supervisor timings (tests shorten them). */
  externalTiming?: { restartBackoffMs?: number; stableMs?: number };
}): Promise<TestbedRuntime> {
  const { config, env, log, cores, cwd, externalTiming } = options;
  const bus = new EventBus({
    bufferSize: config.eventBuffer,
    maxPayloadBytes: config.maxPayloadBytes,
  });
  const store =
    config.runStore === 'file'
      ? await openFileRunStore({ dataDir: config.dataDir, retention: config.runRetention })
      : createMemoryRunStore(config.runRetention);
  const runs = new RunManager(bus, store);
  const host = new CoreHost({
    bus,
    runs,
    log,
    env,
    bindHost: config.bindHost,
    publicHost: new URL(config.publicUrl).hostname,
    ...(cwd === undefined ? {} : { cwd }),
    ...(externalTiming === undefined ? {} : { externalTiming }),
  });
  for (const core of cores) host.register(core);
  return { bus, store, runs, host };
}

/**
 * The control plane over a runtime: lease, control service, the WS hub and
 * the MCP endpoint,
 * ready for `buildApp`. Call `dispose` on shutdown.
 */
export function createControlPlane(
  rt: TestbedRuntime,
  options: { config: TestbedConfig; server: Pick<ServerConfig, 'authDriver' | 'oidc'> },
): TestbedHttp & { dispose(): Promise<void> } {
  const { config, server } = options;
  const lease = new LeaseManager(rt.bus, { ttlSec: config.leaseTtlSec });
  const control = new ControlService(rt, lease, {
    name: packageJson.name,
    version: APP_VERSION,
    baseVersion: TESTBED_BASE_VERSION,
    authControl: config.controlToken === undefined ? 'none' : 'bearer',
    runStore: config.runStore,
    publicUrl: config.publicUrl,
  });
  const hub = new TestbedSocketHub(control, rt.bus);
  const auth = {
    server,
    ...(config.controlToken === undefined ? {} : { controlToken: config.controlToken }),
  };
  const mcp = new McpEndpoint({
    control,
    auth,
    name: packageJson.name,
    version: APP_VERSION,
    maxSessions: config.mcpMaxSessions,
    sessionIdleSec: config.mcpSessionIdleSec,
  });
  return {
    control,
    hub,
    mcp,
    auth,
    async dispose() {
      await mcp.dispose();
      hub.dispose();
      lease.dispose();
    },
  };
}
