/**
 * `scan_history` (docs/spec.md §9) over the shipped fixture, its period rules,
 * and the fixture itself staying inside the pinned contract.
 */
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ValidationError } from '@shared/validation';
import { validateRecord, validateSnapshot } from 'slack-agent-org/src/diag/events';

import { scanHistory, scanWindow } from './scan';
import { DiagSource } from './source';

const FIXTURE = join(import.meta.dir, '../../../../../fixtures/agent-data');
const H = 60 * 60 * 1000;

describe('the fixture', () => {
  test('every line and the snapshot fit the pinned contract', async () => {
    const diag = join(FIXTURE, 'diag');
    const lines = (await readFile(join(diag, 'diag-2026-01-02.jsonl'), 'utf8')).trim().split('\n');
    for (const line of lines) expect(validateRecord(JSON.parse(line))).toEqual({ ok: true });
    const snapshot = JSON.parse(await readFile(join(diag, 'status.json'), 'utf8')) as unknown;
    expect(validateSnapshot(snapshot)).toEqual({ ok: true });
  });
});

describe('scan_history', () => {
  test('the fixture hour: one rescued DM, one drop, one sleep, two turns', async () => {
    const out = await scanHistory(
      new DiagSource(FIXTURE),
      { since: '2026-01-02T00:00:00.000Z', until: '2026-01-02T01:00:00.000Z' },
      Date.now(),
    );
    expect(out).toMatchObject({
      records: 26,
      invalid: 0,
      boots: ['b-fixture1'],
      socket: { connections: 2, disconnectRequests: 0, reconnectFailures: 0 },
      messages: { socket: 1, catchup: 2 },
      clockGaps: { count: 1, totalMs: 1_080_000, maxMs: 1_080_000 },
      turns: { count: 2, failed: 0 },
    });
    expect(out.socket.closes).toEqual([
      { t: '2026-01-02T00:50:00.000Z', conn: 1, code: 1006, livedMs: 2_999_000 },
    ]);
    expect(out.messages.rescued).toEqual([
      expect.objectContaining({ delayMs: 300_000, outcome: 'queued' }) as never,
    ]);
  });

  test('a narrower period counts only its records', async () => {
    const out = await scanHistory(
      new DiagSource(FIXTURE),
      { since: '2026-01-02T00:45:00.000Z', until: '2026-01-02T01:00:00.000Z' },
      Date.now(),
    );
    expect(out.messages.rescued).toEqual([]);
    expect(out.socket.closes).toHaveLength(1);
  });

  test('no folder: an empty summary, not an error', async () => {
    const out = await scanHistory(new DiagSource('/nonexistent-agent-data'), {}, Date.now());
    expect(out.records).toBe(0);
  });

  test('periods: hours back from now, since/until, at most 7 days, since not after until', () => {
    const now = Date.parse('2026-01-10T00:00:00.000Z');
    expect(scanWindow({}, now)).toEqual({ from: now - 24 * H, to: now });
    expect(scanWindow({ hours: 3 }, now)).toEqual({ from: now - 3 * H, to: now });
    expect(() =>
      scanWindow({ since: '2026-01-01T00:00:00.000Z', until: '2026-01-09T00:00:00.000Z' }, now),
    ).toThrow(ValidationError);
    expect(() =>
      scanWindow({ since: '2026-01-05T00:00:00.000Z', until: '2026-01-04T00:00:00.000Z' }, now),
    ).toThrow(ValidationError);
  });
});
