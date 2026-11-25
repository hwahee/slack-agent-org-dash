import { describe, expect, test } from 'bun:test';

import { ValidationError } from '@shared/validation';

import { loadTestbedConfig } from './config';

describe('loadTestbedConfig', () => {
  test('defaults (docs/testbed/architecture.md §7)', () => {
    expect(loadTestbedConfig({}, 40000)).toEqual({
      bindHost: '127.0.0.1',
      publicUrl: 'http://localhost:40000',
      eventBuffer: 5000,
      runStore: 'memory',
      dataDir: './data',
      runRetention: 50,
      maxPayloadBytes: 16_384,
      leaseTtlSec: 600,
      mcpMaxSessions: 32,
      mcpSessionIdleSec: 3600,
      exampleCores: [],
    });
  });

  test('TESTBED_EXAMPLE_CORES is a comma list', () => {
    expect(
      loadTestbedConfig({ TESTBED_EXAMPLE_CORES: ' py-echo, ,other ' }, 0).exampleCores,
    ).toEqual(['py-echo', 'other']);
  });

  test('reads the env, and empty values mean the default', () => {
    const config = loadTestbedConfig(
      {
        TESTBED_BIND_HOST: '0.0.0.0',
        TESTBED_PUBLIC_URL: 'http://testbed.example:40000',
        TESTBED_RUN_STORE: 'file',
        TESTBED_RUN_RETENTION: '3',
        TESTBED_DATA_DIR: '',
      },
      40000,
    );
    expect(config).toMatchObject({
      bindHost: '0.0.0.0',
      publicUrl: 'http://testbed.example:40000',
      runStore: 'file',
      runRetention: 3,
      dataDir: './data',
    });
  });

  test('a bad value fails the boot', () => {
    expect(() => loadTestbedConfig({ TESTBED_RUN_STORE: 'redis' }, 40000)).toThrow(ValidationError);
  });
});
