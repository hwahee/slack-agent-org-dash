/**
 * Puts the common runtime together for one boot: event bus, Run store and
 * manager, and the core host with this testbed's cores registered.
 */
import type { Logger } from '../lib/log';
import type { TestbedConfig } from './config';
import type { CoreDefinition } from './core';
import { CoreHost } from './core-host';
import { EventBus } from './events/bus';
import { openFileRunStore } from './runs/file-store';
import { createMemoryRunStore } from './runs/memory-store';
import { RunManager } from './runs/runs';

export interface TestbedRuntime {
  bus: EventBus;
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
  return { bus, runs, host };
}
