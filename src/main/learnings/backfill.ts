// src/main/learnings/backfill.ts
import { createLogger } from '../logger';
import type { LearningsStore } from './learnings-store';
import type { Embedder } from './embedder';

const log = createLogger('learnings-backfill');

const BATCH = 25;
const SLEEP_MS = 50;

const sleep = async (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Embed every learning that lacks a fresh vector (existing rows from before v2, and
 * rows edited since). Runs in the background after startup, yielding between rows so
 * it never monopolizes the main thread. If the embedder is unavailable it stops and
 * leaves rows pending for the next launch — embeddings are best-effort.
 */
export async function runBackfill(store: LearningsStore, embedder: Embedder): Promise<void> {
  if (!store.hasVectorSupport()) return;
  let processed = 0;
  for (;;) {
    const batch = store.pendingEmbeddings(BATCH);
    if (batch.length === 0) break;
    for (const row of batch) {
      const vec = await embedder.embed(`${row.title}\n${row.body}`);
      if (!vec) {
        if (processed) log.info('backfill paused (embedder unavailable)', { processed });
        return;
      }
      store.setEmbedding(row.id, vec);
      processed++;
      await sleep(SLEEP_MS);
    }
  }
  if (processed) log.info('backfilled learning embeddings', { processed });
}
