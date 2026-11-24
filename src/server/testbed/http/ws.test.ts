import { describe, expect, test } from 'bun:test';

import { sampleCore } from '../cores/sample';
import { createTestControlPlane } from '../testing';
import type { TestbedSocketMessage } from '@shared/testbed/control';

describe('WS back-pressure', () => {
  test('above 200 events a second the stream is sampled and the batches count what was left out', async () => {
    const { runtime, plane } = await createTestControlPlane({ cores: [sampleCore] });
    const received: TestbedSocketMessage[] = [];
    plane.hub.open({
      send: (data: string) => received.push(JSON.parse(data) as TestbedSocketMessage),
    });

    for (let i = 0; i < 1200; i += 1) {
      runtime.bus.emit({
        core: 'sample',
        kind: 'sample.data.echoed',
        actor: 'product',
        summary: `#${i}`,
      });
    }
    // Wait for the 100 ms flush by waiting on a message, not on time.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (received.some((message) => message.type === 'event')) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });

    const batches = received.filter(
      (message): message is Extract<TestbedSocketMessage, { type: 'event' }> =>
        message.type === 'event',
    );
    const sent = batches.reduce((sum, batch) => sum + batch.events.length, 0);
    const omitted = batches.reduce((sum, batch) => sum + batch.omitted, 0);
    expect(sent + omitted).toBe(1200);
    expect(sent).toBe(200 + 100);
    expect(omitted).toBe(900);
    // Nothing is lost where it is kept.
    expect(
      runtime.bus.buffered().filter((event) => event.kind === 'sample.data.echoed'),
    ).toHaveLength(1200);
    await plane.dispose();
  });
});
