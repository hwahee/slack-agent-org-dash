/**
 * `scan_history` (docs/spec.md §9): one read-only pass over the record files
 * of a period, summed up — what an observer wants to know about the last hours
 * without moving every record over as an event.
 */
import { s, toValidator, ValidationError, type Infer } from '@shared/validation';
import { DIAG_VERSION, validateRecord, type DiagRecord } from 'slack-agent-org/src/diag/events';

import type { DiagSource } from './source';
import { MAX_READ_BYTES } from './tailer';

const HOUR_MS = 60 * 60 * 1000;
const MAX_WINDOW_MS = 7 * 24 * HOUR_MS;
const MAX_RESCUED = 50;

export const scanInput = toValidator(
  s.object({
    hours: s.optional(s.int().check(s.gte(1), s.lte(168))),
    since: s.optional(s.iso.datetime()),
    until: s.optional(s.iso.datetime()),
  }),
);

export const scanOutput = toValidator(
  s.object({
    from: s.string(),
    to: s.string(),
    records: s.int(),
    invalid: s.int(),
    byKind: s.record(s.string(), s.int()),
    boots: s.array(s.string()),
    socket: s.object({
      connections: s.int(),
      closes: s.array(
        s.object({ t: s.string(), conn: s.int(), code: s.int(), livedMs: s.number() }),
      ),
      disconnectRequests: s.int(),
      reconnectFailures: s.int(),
    }),
    messages: s.object({
      socket: s.int(),
      catchup: s.int(),
      rescued: s.array(
        s.object({ t: s.string(), id: s.string(), delayMs: s.number(), outcome: s.string() }),
      ),
    }),
    clockGaps: s.object({ count: s.int(), totalMs: s.number(), maxMs: s.number() }),
    turns: s.object({ count: s.int(), failed: s.int() }),
  }),
);

export type ScanOutput = Infer<typeof scanOutput>;

/** The period: `since`/`until` if given (at most 7 days), else the last `hours` (default 24). */
export function scanWindow(
  input: Infer<typeof scanInput>,
  now: number,
): { from: number; to: number } {
  const to = input.until !== undefined ? Date.parse(input.until) : now;
  const from =
    input.since !== undefined ? Date.parse(input.since) : to - (input.hours ?? 24) * HOUR_MS;
  if (from > to) {
    throw new ValidationError([
      { path: 'since', code: 'custom', message: 'since가 until보다 늦음' },
    ]);
  }
  if (to - from > MAX_WINDOW_MS) {
    throw new ValidationError([{ path: 'since', code: 'custom', message: '기간은 7일까지' }]);
  }
  return { from, to };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function* lines(source: DiagSource, name: string, size: number): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let offset = 0;
  let rest = '';
  while (offset < size) {
    const bytes = await source.read(name, offset, Math.min(MAX_READ_BYTES, size - offset));
    if (bytes.length === 0) break;
    offset += bytes.length;
    const text = rest + decoder.decode(bytes, { stream: offset < size });
    const parts = text.split('\n');
    rest = parts.pop() ?? '';
    yield* parts;
  }
  if (rest !== '') yield rest;
}

export async function scanHistory(
  source: DiagSource,
  input: Infer<typeof scanInput>,
  now: number,
): Promise<ScanOutput> {
  const { from, to } = scanWindow(input, now);
  const out: ScanOutput = {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    records: 0,
    invalid: 0,
    byKind: {},
    boots: [],
    socket: { connections: 0, closes: [], disconnectRequests: 0, reconnectFailures: 0 },
    messages: { socket: 0, catchup: 0, rescued: [] },
    clockGaps: { count: 0, totalMs: 0, maxMs: 0 },
    turns: { count: 0, failed: 0 },
  };
  const listing = await source.list();
  if (!listing.ok) return out;
  const firstDay = day(from);
  const lastDay = day(to);
  const boots = new Set<string>();

  for (const file of listing.files) {
    if (file.day < firstDay || file.day > lastDay) continue;
    for await (const line of lines(source, file.name, file.size)) {
      if (line.trim() === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        out.invalid += 1;
        continue;
      }
      if ((value as { v?: unknown } | null)?.v !== DIAG_VERSION || !validateRecord(value).ok) {
        out.invalid += 1;
        continue;
      }
      const r = value as DiagRecord;
      const t = Date.parse(r.t);
      if (t < from || t > to) continue;
      out.records += 1;
      out.byKind[r.kind] = (out.byKind[r.kind] ?? 0) + 1;
      boots.add(r.boot);
      tally(out, r);
    }
  }
  out.boots = [...boots];
  out.messages.rescued = out.messages.rescued
    .sort((a, b) => b.delayMs - a.delayMs)
    .slice(0, MAX_RESCUED);
  return out;
}

function tally(out: ScanOutput, r: DiagRecord): void {
  const f = r;
  switch (r.kind) {
    case 'socket.hello':
      out.socket.connections += 1;
      return;
    case 'socket.closed':
      out.socket.closes.push({
        t: r.t,
        conn: f.conn as number,
        code: f.code as number,
        livedMs: f.livedMs as number,
      });
      return;
    case 'socket.disconnect-requested':
      out.socket.disconnectRequests += 1;
      return;
    case 'socket.reconnect-failed':
      out.socket.reconnectFailures += 1;
      return;
    case 'message.observed': {
      if (f.path === 'socket') out.messages.socket += 1;
      else out.messages.catchup += 1;
      if (f.path === 'catchup' && (f.outcome === 'queued' || f.outcome === 'overheard')) {
        out.messages.rescued.push({
          t: r.t,
          id: f.id as string,
          delayMs: f.delayMs as number,
          outcome: f.outcome,
        });
      }
      return;
    }
    case 'clock.gap': {
      const ms = Math.max(f.wallElapsedMs as number, f.monoElapsedMs as number);
      out.clockGaps.count += 1;
      out.clockGaps.totalMs += ms;
      out.clockGaps.maxMs = Math.max(out.clockGaps.maxMs, ms);
      return;
    }
    case 'turn.ended':
      out.turns.count += 1;
      if (f.ok === false) out.turns.failed += 1;
      return;
    default:
      return;
  }
}
