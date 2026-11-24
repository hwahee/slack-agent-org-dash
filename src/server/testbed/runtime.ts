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
import type { CoreDefinition } from './core';
import { CoreHost } from './core-host';
import { EventBus } from './events/bus';
import type { TestbedHttp } from './http/routes';
import { TestbedSocketHub } from './http/ws';
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
  cores: readonly CoreDefinition[];
}): Promise<TestbedRuntime> {
  const { config, env, log, cores } = options;
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
  });
  for (const core of cores) host.register(core);
  return { bus, store, runs, host };
}

/**
 * The control plane over a runtime: lease, control service and the WS hub,
 * ready for `buildApp`. Call `dispose` on shutdown.
 */
export function createControlPlane(
  rt: TestbedRuntime,
  options: { config: TestbedConfig; server: Pick<ServerConfig, 'authDriver' | 'oidc'> },
): TestbedHttp & { dispose(): void } {
  const { config, server } = options;
  const lease = new LeaseManager(rt.bus, { ttlSec: config.leaseTtlSec });
  const control = new ControlService(rt, lease, {
    name: packageJson.name,
    version: APP_VERSION,
    baseVersion: TESTBED_BASE_VERSION,
    authControl: config.controlToken === undefined ? 'none' : 'bearer',
    runStore: config.runStore,
  });
  const hub = new TestbedSocketHub(control, rt.bus);
  return {
    control,
    hub,
    auth: {
      server,
      ...(config.controlToken === undefined ? {} : { controlToken: config.controlToken }),
    },
    dispose() {
      hub.dispose();
      lease.dispose();
    },
  };
}
