import { describe, expect, test } from 'bun:test';

import { TestbedError } from '../errors';
import { EventBus, type EventInput } from './bus';

function input(overrides: Partial<EventInput> = {}): EventInput {
  return {
    core: 'sample',
    kind: 'sample.data.echoed',
    actor: 'product',
    summary: 'x',
    ...overrides,
  };
}

describe('EventBus envelope', () => {
  test('fills seq, id, ts, runId, level and keeps the optional fields given', () => {
    const bus = new EventBus({ instanceId: 'b' });
    bus.currentRunId = 'run-1-abcd';
    const event = bus.emit(input({ correlationId: 'c-1', latencyMs: 4, payload: { bytes: 3 } }));
    expect(event).toMatchObject({
      seq: 0,
      id: 'b:0',
      runId: 'run-1-abcd',
      level: 'info',
      correlationId: 'c-1',
      latencyMs: 4,
      payload: { bytes: 3 },
    });
    expect(event.ts).toMatch(/Z$/);
    expect('truncated' in event).toBe(false);
  });

  test('hands every event to subscribers until they unsubscribe', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.seq));
    bus.emit(input());
    unsubscribe();
    bus.emit(input());
    expect(seen).toEqual([0]);
  });
});

describe('EventBus.query — cursors and filters', () => {
  test('after a cursor: only the events after it', () => {
    const bus = new EventBus({ instanceId: 'boot1' });
    for (let i = 0; i < 4; i += 1) bus.emit(input({ summary: `#${i}` }));
    expect(bus.query({ after: 'boot1:1' }).map((event) => event.summary)).toEqual(['#2', '#3']);
  });

  test('a cursor from another instance is CURSOR_STALE with the fresh cursor in details', () => {
    const bus = new EventBus({ instanceId: 'boot2' });
    bus.emit(input());
    let error: unknown;
    try {
      bus.query({ after: 'boot1:3' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TestbedError);
    expect((error as TestbedError).code).toBe('CURSOR_STALE');
    expect((error as TestbedError).details).toEqual({ cursor: 'boot2:0' });
  });

  test('kind prefix, level floor, actor, correlationId, text, runId and limit', () => {
    const bus = new EventBus();
    bus.emit(input({ kind: 'llm.completion.requested', level: 'debug', correlationId: 'r1' }));
    bus.emit(input({ kind: 'llm.completion.responded', level: 'warn', summary: 'slow reply' }));
    bus.emit(input({ kind: 'llm.completionx.odd', actor: 'agent' }));
    bus.currentRunId = 'run-1-aaaa';
    bus.emit(input({ kind: 'sample.data.echoed', level: 'error' }));

    const kinds = (filter: Parameters<EventBus['query']>[0]) =>
      bus.query(filter).map((event) => event.kind);
    expect(kinds({ kind: 'llm.completion' })).toEqual([
      'llm.completion.requested',
      'llm.completion.responded',
    ]);
    expect(kinds({ level: 'warn' })).toEqual(['llm.completion.responded', 'sample.data.echoed']);
    expect(kinds({ actor: 'agent' })).toEqual(['llm.completionx.odd']);
    expect(kinds({ correlationId: 'r1' })).toEqual(['llm.completion.requested']);
    expect(kinds({ text: 'slow' })).toEqual(['llm.completion.responded']);
    expect(kinds({ runId: 'current' })).toEqual(['sample.data.echoed']);
    expect(kinds({ runId: 'run-1-aaaa' })).toEqual(['sample.data.echoed']);
    expect(kinds({ limit: 2 })).toHaveLength(2);
  });

  test("runId 'current' with no open Run matches nothing", () => {
    const bus = new EventBus();
    bus.emit(input());
    expect(bus.query({ runId: 'current' })).toEqual([]);
  });
});
