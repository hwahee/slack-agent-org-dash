/**
 * The agent's diagnostics folder, read only (docs/spec.md §2, §4). This is the
 * one module of the agent core that touches the file system, and it can only
 * list, stat and read: ESLint forbids every writing API under cores/agent/,
 * and files are opened with the `r` flag.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { SnapshotRead } from './health';

const RECORD_FILE = /^diag-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface RecordFile {
  name: string;
  /** `YYYY-MM-DD` (UTC) from the name. */
  day: string;
  size: number;
}

export type Listing =
  | { ok: true; files: RecordFile[] }
  /** `missing`: no folder yet (absent, not an error); `unreadable`: there but not readable. */
  | { ok: false; reason: 'missing' | 'unreadable'; error: string };

const codeOf = (error: unknown) => (error as { code?: string } | null)?.code ?? '';
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class DiagSource {
  constructor(private readonly dataDir: string) {}

  get folder(): string {
    return join(this.dataDir, 'diag');
  }

  /** The record files, oldest day first. */
  async list(): Promise<Listing> {
    let names: string[];
    try {
      names = await readdir(this.folder);
    } catch (error) {
      return codeOf(error) === 'ENOENT'
        ? { ok: false, reason: 'missing', error: messageOf(error) }
        : { ok: false, reason: 'unreadable', error: messageOf(error) };
    }
    const files: RecordFile[] = [];
    for (const name of names.sort()) {
      const day = RECORD_FILE.exec(name)?.[1];
      if (day === undefined) continue;
      try {
        const info = await stat(join(this.folder, name));
        if (info.isFile()) files.push({ name, day, size: info.size });
      } catch {
        // Removed between readdir and stat (the agent's retention): skip it.
      }
    }
    return { ok: true, files };
  }

  /** Up to `max` bytes of a record file from `offset`. */
  async read(name: string, offset: number, max: number): Promise<Uint8Array> {
    const handle = await open(join(this.folder, name), 'r');
    try {
      const buffer = new Uint8Array(max);
      const { bytesRead } = await handle.read(buffer, 0, max, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async status(): Promise<SnapshotRead> {
    let text: string;
    try {
      text = await readFile(join(this.folder, 'status.json'), 'utf8');
    } catch (error) {
      return {
        ok: false,
        why:
          codeOf(error) === 'ENOENT'
            ? 'status.json 없음'
            : `status.json을 읽을 수 없음: ${messageOf(error)}`,
      };
    }
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      // Caught mid-replace is impossible (the agent renames atomically), so this is a bad file.
      return { ok: false, why: 'status.json이 JSON이 아님' };
    }
  }
}
