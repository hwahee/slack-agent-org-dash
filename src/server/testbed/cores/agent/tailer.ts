/**
 * Follows the agent's record files (docs/spec.md §4, §5.1, §5.4): remembers a
 * byte offset per file, reads what was appended, hands over complete lines and
 * keeps a trailing half line for the next read.
 */
import { DIAG_VERSION, validateRecord, type DiagRecord } from 'slack-agent-org/src/diag/events';

import type { DiagSource, RecordFile } from './source';

/** At most this much of one file per read; the rest comes on the next read. */
export const MAX_READ_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
const PREVIEW_CHARS = 200;

export type TailItem =
  | { type: 'record'; file: string; record: DiagRecord; replayed: boolean }
  | { type: 'invalid'; file: string; line: number; problem: string; preview: string }
  | { type: 'mismatch'; file: string; found: unknown };

interface Position {
  offset: number;
  /** Lines consumed so far (1-based number of the next line is `lines + 1`). */
  lines: number;
  /** Inside an over-long line: drop bytes up to the next newline. */
  skipping: boolean;
}

export interface TailOptions {
  /** Records older than this (epoch ms) are not handed over on the first pass. */
  backfillFrom: number | null;
}

export class Tailer {
  private readonly positions = new Map<string, Position>();
  /** Highest `seq` seen per agent `boot` — a re-read line is not handed over twice. */
  private readonly seen = new Map<string, number>();
  private readonly mismatched = new Set<string>();
  private first = true;
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly source: DiagSource,
    private readonly options: TailOptions,
  ) {}

  /** Starts over: the next `poll` is a first pass again (with backfill). */
  reset(backfillFrom: number | null): void {
    this.positions.clear();
    this.seen.clear();
    this.mismatched.clear();
    this.first = true;
    this.options.backfillFrom = backfillFrom;
  }

  /** One pass over the listed files. */
  async poll(files: RecordFile[]): Promise<TailItem[]> {
    const items: TailItem[] = [];
    const firstPass = this.first;
    this.first = false;
    const listed = new Set(files.map((file) => file.name));
    for (const name of this.positions.keys()) if (!listed.has(name)) this.positions.delete(name);

    for (const file of files) {
      let position = this.positions.get(file.name);
      if (position === undefined) {
        position = { offset: 0, lines: 0, skipping: false };
        if (firstPass && !this.wanted(file)) position.offset = file.size;
        this.positions.set(file.name, position);
      } else if (file.size < position.offset) {
        // The file got shorter: it was rewritten, read it again from the top.
        position.offset = 0;
        position.lines = 0;
        position.skipping = false;
      }
      if (file.size > position.offset) {
        items.push(...(await this.readFile(file.name, position, firstPass)));
      }
    }
    return items;
  }

  /** On the first pass only files of days inside the backfill window are read. */
  private wanted(file: RecordFile): boolean {
    const from = this.options.backfillFrom;
    if (from === null) return false;
    const dayEnd = Date.parse(`${file.day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
    return dayEnd > from;
  }

  private async readFile(
    name: string,
    position: Position,
    firstPass: boolean,
  ): Promise<TailItem[]> {
    const bytes = await this.source.read(name, position.offset, MAX_READ_BYTES);
    if (bytes.length === 0) return [];
    let start = 0;
    const items: TailItem[] = [];

    if (position.skipping) {
      const end = bytes.indexOf(NEWLINE);
      if (end === -1) {
        position.offset += bytes.length;
        return [];
      }
      start = end + 1;
      position.skipping = false;
    }

    let lastNewline = bytes.lastIndexOf(NEWLINE);
    if (lastNewline < start) lastNewline = -1;
    if (lastNewline === -1) {
      // A whole chunk from a line's start without a newline: the line is too long.
      if (start === 0 && bytes.length >= MAX_READ_BYTES) {
        position.lines += 1;
        items.push({
          type: 'invalid',
          file: name,
          line: position.lines,
          problem: 'line too long',
          preview: this.decoder
            .decode(bytes.subarray(start, start + PREVIEW_CHARS * 4))
            .slice(0, PREVIEW_CHARS),
        });
        position.offset += bytes.length;
        position.skipping = true;
        return items;
      }
      position.offset += start; // a half line: wait for its newline
      return items;
    }

    const text = this.decoder.decode(bytes.subarray(start, lastNewline));
    position.offset += lastNewline + 1;
    for (const line of text.split('\n')) {
      position.lines += 1;
      if (line.trim() === '') continue;
      items.push(...this.parse(name, position.lines, line, firstPass));
    }
    return items;
  }

  private parse(file: string, lineNo: number, line: string, firstPass: boolean): TailItem[] {
    const invalid = (problem: string): TailItem => ({
      type: 'invalid',
      file,
      line: lineNo,
      problem,
      preview: line.slice(0, PREVIEW_CHARS),
    });
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return [invalid('not JSON')];
    }
    const version = (value as { v?: unknown } | null)?.v;
    if (version !== DIAG_VERSION) {
      if (this.mismatched.has(file)) return [];
      this.mismatched.add(file);
      return [{ type: 'mismatch', file, found: version }];
    }
    const checked = validateRecord(value);
    if (!checked.ok) return [invalid(checked.problem)];
    const record = value as DiagRecord;

    const last = this.seen.get(record.boot);
    if (last !== undefined && record.seq <= last) return [];
    this.seen.set(record.boot, record.seq);

    if (firstPass) {
      const from = this.options.backfillFrom;
      if (from === null || Date.parse(record.t) < from) return [];
    }
    return [{ type: 'record', file, record, replayed: firstPass }];
  }
}
