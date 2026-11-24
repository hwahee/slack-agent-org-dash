import { describe, expect, test } from 'bun:test';

import { EventBus } from './bus';
import { RingBuffer } from './ring-buffer';

describe('RingBuffer', () => {
  test('keeps the newest items up to capacity, oldest first', () => {
    const ring = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4]) ring.push(n);
    expect(ring.toArray()).toEqual([2, 3, 4]);
  });

  test('rejects a capacity below 1', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });
});

describe('the event ring buffer', () => {
  test('capacity 5, 7 events: the oldest 2 drop out and seq keeps increasing', () => {
    const bus = new EventBus({ instanceId: 'boot1', bufferSize: 5 });
    for (let i = 0; i < 7; i += 1) {
      bus.emit({
        core: 'sample',
        kind: 'sample.thing.happened',
        actor: 'product',
        summary: `#${i}`,
      });
    }
    const kept = bus.buffered();
    expect(kept.map((event) => event.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(kept.map((event) => event.id)).toEqual([
      'boot1:2',
      'boot1:3',
      'boot1:4',
      'boot1:5',
      'boot1:6',
    ]);
    const next = bus.emit({
      core: 'sample',
      kind: 'sample.thing.happened',
      actor: 'product',
      summary: '#7',
    });
    expect(next.seq).toBe(7);
  });
});
