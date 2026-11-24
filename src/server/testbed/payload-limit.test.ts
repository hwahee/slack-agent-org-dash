import { describe, expect, test } from 'bun:test';

import { EventBus } from './events/bus';
import { limitPayload, type TruncatedPayload } from './payload-limit';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('limitPayload', () => {
  test('leaves a payload under the cap alone', () => {
    const payload = { a: 'x'.repeat(100) };
    expect(limitPayload(payload, 16_384)).toEqual({ payload, truncated: false });
  });

  test('a 20KB payload becomes the front of its JSON, within 16KB, marked truncated', () => {
    const payload = { body: 'a'.repeat(20_000), quotes: '"'.repeat(500) };
    const original = JSON.stringify(payload);
    const { payload: limited, truncated } = limitPayload(payload, 16_384);
    expect(truncated).toBe(true);
    expect(bytes(limited)).toBeLessThanOrEqual(16_384);
    const { preview, bytes: size } = limited as TruncatedPayload;
    expect(size).toBe(bytes(payload));
    expect(original.startsWith(preview)).toBe(true);
    expect(preview.length).toBeGreaterThan(15_000);
  });

  test('never cuts a multi-byte character in half', () => {
    const { payload } = limitPayload({ text: '가'.repeat(10_000) }, 1_000);
    expect((payload as TruncatedPayload).preview).not.toContain('�');
    expect(bytes(payload)).toBeLessThanOrEqual(1_000);
  });
});

describe('the bus applies the cap', () => {
  test('a 20KB payload is stored at 16KB or less with truncated: true', () => {
    const bus = new EventBus();
    const event = bus.emit({
      core: 'sample',
      kind: 'sample.data.received',
      actor: 'product',
      summary: 'big',
      payload: { body: 'z'.repeat(20 * 1024) },
    });
    expect(event.truncated).toBe(true);
    expect(bytes(event.payload)).toBeLessThanOrEqual(16 * 1024);
  });
});
