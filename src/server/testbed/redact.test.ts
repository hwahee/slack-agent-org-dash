import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { EventBus } from './events/bus';
import { maskSecret, redact } from './redact';
import { openFileRunStore } from './runs/file-store';
import { RunManager } from './runs/runs';

const SECRET = 'Bearer sk-abcdef0123456789abcdef0123456789abcdef0123';

function expectedMask(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${value.slice(0, 4)}…(len ${value.length}, sha256:${digest})`;
}

describe('maskSecret', () => {
  test('keeps the first 4 characters, the length and 12 hex of sha256', () => {
    expect(maskSecret(SECRET)).toBe(expectedMask(SECRET));
    expect(maskSecret(SECRET)).toMatch(/^Bear…\(len 52, sha256:[0-9a-f]{12}\)$/);
  });
});

describe('redact', () => {
  test('masks the common secret keys at any depth, and nothing else', () => {
    const masked = redact({
      headers: {
        Authorization: SECRET,
        cookie: 'sid=1',
        'Set-Cookie': ['a=1', 'b=2'],
        'x-api-key': 'k-123456',
        'content-type': 'application/json',
      },
      body: { access_token: 'tok-1', clientSecret: 'shh', password: 12345, user: 'alice' },
    });
    expect(masked).toEqual({
      headers: {
        Authorization: expectedMask(SECRET),
        cookie: expectedMask('sid=1'),
        'Set-Cookie': [expectedMask('a=1'), expectedMask('b=2')],
        'x-api-key': expectedMask('k-123456'),
        'content-type': 'application/json',
      },
      body: {
        access_token: expectedMask('tok-1'),
        clientSecret: expectedMask('shh'),
        password: expectedMask('12345'),
        user: 'alice',
      },
    });
  });

  test('takes extra keys from the core', () => {
    expect(redact({ sessionCode: 'abcdef', other: 'x' }, ['SessionCode'])).toEqual({
      sessionCode: expectedMask('abcdef'),
      other: 'x',
    });
  });
});

describe('secrets never reach storage', () => {
  test('the original is in neither the ring buffer nor the file store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'testbed-redact-'));
    try {
      const bus = new EventBus({ instanceId: 'b' });
      const store = await openFileRunStore({ dataDir });
      const runs = new RunManager(bus, store);
      const run = await runs.start({ label: 'secrets' }, { actor: 'ci' });
      bus.emit({
        core: 'sample',
        kind: 'sample.request.received',
        actor: 'product',
        summary: 'request with auth',
        payload: { headers: { Authorization: SECRET } },
      });
      await runs.end({ actor: 'ci' });

      expect(JSON.stringify(bus.buffered())).not.toContain('sk-abcdef');
      expect(JSON.stringify(bus.buffered())).toContain(expectedMask(SECRET));
      const jsonl = await readFile(join(dataDir, 'runs', `${run.runId}.jsonl`), 'utf8');
      expect(jsonl).not.toContain('sk-abcdef');
      expect(jsonl).toContain(expectedMask(SECRET));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
