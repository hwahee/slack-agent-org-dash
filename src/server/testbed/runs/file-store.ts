/**
 * `TESTBED_RUN_STORE=file`: each Run is `<dataDir>/runs/<runId>.jsonl` (one
 * event per line — also the export format) plus `<runId>.meta.json`.
 *
 * Appends are batched and written shortly after (or when the Run closes or is
 * read). Opening the store closes every Run a restart left open, as
 * `endedBy: system`, `endReason: 'restart'`, with a summary rebuilt from its
 * events.
 */
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { TestbedEvent } from '@shared/testbed/events';
import type { RunMeta } from '@shared/testbed/runs';
import { nowUtc, type UtcIsoString } from '@shared/time';

import { DEFAULT_RUN_RETENTION, newestFirst, runsOverRetention, type RunStore } from './store';
import { SummaryBuilder } from './summary';

/** How long appends wait to be written together. */
const FLUSH_DELAY_MS = 50;

export interface FileRunStoreOptions {
  /** `TESTBED_DATA_DIR`; Runs go under `<dataDir>/runs/`. */
  dataDir: string;
  retention?: number;
  now?: () => UtcIsoString;
}

async function readJsonl(path: string): Promise<TestbedEvent[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TestbedEvent);
}

export async function openFileRunStore(options: FileRunStoreOptions): Promise<RunStore> {
  const dir = join(options.dataDir, 'runs');
  const retention = options.retention ?? DEFAULT_RUN_RETENTION;
  const now = options.now ?? nowUtc;
  await mkdir(dir, { recursive: true });

  const metaPath = (runId: string) => join(dir, `${runId}.meta.json`);
  const eventsPath = (runId: string) => join(dir, `${runId}.jsonl`);
  const metas = new Map<string, RunMeta>();

  const writeMeta = (meta: RunMeta) =>
    writeFile(metaPath(meta.runId), JSON.stringify(meta, null, 2));

  // ── Batched appends ──────────────────────────────────────────────────────
  let pending = new Map<string, string[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> = Promise.resolve();

  function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const batch = pending;
    pending = new Map();
    writing = writing.then(async () => {
      for (const [runId, lines] of batch) await appendFile(eventsPath(runId), lines.join(''));
    });
    return writing;
  }

  async function applyRetention(): Promise<void> {
    for (const runId of runsOverRetention([...metas.values()], retention)) {
      metas.delete(runId);
      pending.delete(runId);
      await rm(metaPath(runId), { force: true });
      await rm(eventsPath(runId), { force: true });
    }
  }

  // ── Recover what the last boot left behind ───────────────────────────────
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.meta.json')) continue;
    const meta = JSON.parse(await readFile(join(dir, file), 'utf8')) as RunMeta;
    if (meta.endedAt === undefined) {
      const builder = new SummaryBuilder();
      for (const event of await readJsonl(eventsPath(meta.runId))) builder.add(event);
      const endedAt = now();
      meta.endedAt = endedAt;
      meta.endedBy = { actor: 'system' };
      meta.endReason = 'restart';
      meta.summary = builder.build(meta.startedAt, endedAt);
      await writeMeta(meta);
    }
    metas.set(meta.runId, meta);
  }
  await applyRetention();

  return {
    async create(meta) {
      metas.set(meta.runId, structuredClone(meta));
      await writeMeta(meta);
    },
    append(event) {
      if (event.runId === null || !metas.has(event.runId)) return;
      const lines = pending.get(event.runId) ?? [];
      lines.push(`${JSON.stringify(event)}\n`);
      pending.set(event.runId, lines);
      timer ??= setTimeout(() => void flush(), FLUSH_DELAY_MS);
    },
    async close(meta) {
      await flush();
      metas.set(meta.runId, structuredClone(meta));
      await writeMeta(meta);
      await applyRetention();
    },
    get(runId) {
      const meta = metas.get(runId);
      return Promise.resolve(meta ? structuredClone(meta) : null);
    },
    list() {
      return Promise.resolve(newestFirst([...metas.values()].map((meta) => structuredClone(meta))));
    },
    async events(runId) {
      if (!metas.has(runId)) return [];
      await flush();
      return readJsonl(eventsPath(runId));
    },
    location(runId) {
      return metas.has(runId) ? resolve(eventsPath(runId)) : undefined;
    },
  };
}
