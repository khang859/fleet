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
 * it never monopolizes the main thread.
 *
 * A `null` from `embed` is disambiguated via `embedder.available()`: if the embedder
 * has gone down (model can't load), stop and leave rows pending for the next launch;
 * if it's still up, treat it as a one-off failure for that row — skip it (so it can't
 * wedge the loop) and leave it pending to retry next launch. Embeddings are best-effort.
 */
export async function runBackfill(store: LearningsStore, embedder: Embedder): Promise<void> {
  if (!store.hasVectorSupport()) return;
  let processed = 0;
  let skipped = 0;
  const failedRowids: number[] = [];
  for (;;) {
    const batch = store.pendingEmbeddings(BATCH, failedRowids);
    if (batch.length === 0) break;
    for (const row of batch) {
      const vec = await embedder.embed(`${row.title}\n${row.body}`);
      if (vec) {
        store.setEmbedding(row.id, vec);
        processed++;
      } else if (!embedder.available()) {
        if (processed) log.info('backfill paused (embedder unavailable)', { processed });
        return;
      } else {
        // One-off failure for this row — skip it this run so it can't block the rest.
        failedRowids.push(row.rowid);
        skipped++;
        log.warn('skipping unembeddable learning (will retry next launch)', { id: row.id });
      }
      await sleep(SLEEP_MS);
    }
  }
  if (processed || skipped) log.info('backfilled learning embeddings', { processed, skipped });
}
