import { describe, expect, test } from 'bun:test';

import { ValidationError } from '@shared/validation';

import { NotFoundError } from '../lib/errors';
import { silentLogger } from '../lib/log';
import type { CoreDefinition } from './core';
import { CoreHost } from './core-host';
import { EventBus } from './events/bus';
import { sampleCore } from './cores/sample';
import { createMemoryRunStore } from './runs/memory-store';
import { RunManager } from './runs/runs';

function host(env: Record<string, string> = {}) {
  const bus = new EventBus();
  const runs = new RunManager(bus, createMemoryRunStore());
  return { bus, host: new CoreHost({ bus, runs, log: silentLogger, env }) };
}

describe('CoreHost', () => {
  test('env defaults are validated at registration', () => {
    expect(() => host({ SAMPLE_MAX_CONNECTIONS: '0' }).host.register(sampleCore)).toThrow(
      ValidationError,
    );
    const ok = host({ SAMPLE_PORT: '0', SAMPLE_AUTO_START: 'false' });
    ok.host.register(sampleCore);
    expect(ok.host.getConfig('sample')).toMatchObject({ port: 0, autoStart: false });
    expect(ok.host.status('sample').state).toBe('idle');
  });

  test('a config patch with a key the config does not have is a ValidationError', async () => {
    const { host: h } = host({ SAMPLE_PORT: '0', SAMPLE_AUTO_START: 'false' });
    h.register(sampleCore);
    const before = h.getConfig('sample');
    await expect(h.setConfig('sample', { eventLevl: 'debug' })).rejects.toThrow(ValidationError);
    expect(h.getConfig('sample')).toEqual(before);
  });

  test('autoStart false: startAutoStart leaves the core idle', async () => {
    const { host: h } = host({ SAMPLE_PORT: '0', SAMPLE_AUTO_START: 'false' });
    h.register(sampleCore);
    await h.startAutoStart();
    expect(h.status('sample').state).toBe('idle');
  });

  test('ids must be lowercase and never testbed; no duplicates', () => {
    const { host: h } = host({ SAMPLE_PORT: '0' });
    for (const id of ['Sample', 'testbed', '1st']) {
      expect(() => h.register({ ...sampleCore, id })).toThrow(/invalid core id/);
    }
    h.register(sampleCore);
    expect(() => h.register(sampleCore)).toThrow(/already registered/);
  });

  test('unknown core or action → NotFoundError', async () => {
    const { host: h } = host({ SAMPLE_PORT: '0' });
    h.register(sampleCore);
    expect(() => h.status('nope')).toThrow(NotFoundError);
    await expect(h.invokeAction('sample', 'nope', {}, { actor: 'ci' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test('a core may only emit its own kinds', () => {
    const { host: h } = host();
    let emitted = false;
    const rogue = {
      ...sampleCore,
      id: 'rogue',
      create: (ctx) => {
        expect(() => ctx.emit({ kind: 'testbed.core.state', summary: 'x' })).toThrow(/rogue\.\*/);
        ctx.emit({ kind: 'rogue.thing.happened', summary: 'ok' });
        emitted = true;
        return sampleCore.create(ctx as never);
      },
    } as CoreDefinition;
    h.register(rogue);
    expect(emitted).toBe(true);
  });
});
