// src/main/chat/chat-backfill.ts
import { createLogger } from '../logger';
import type { Embedder } from '../learnings/embedder';
import type { ChatStore } from './chat-store';

const log = createLogger('chat-backfill');

const BATCH = 25;
const SLEEP_MS = 50;

const sleep = async (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Embed every chat message that lacks a fresh vector (messages from before semantic
 * search shipped, and any whose embed-on-write failed). Runs in the background after
 * startup, yielding between rows so it never monopolizes the main thread.
 *
 * A `null` from `embed` is disambiguated via `embedder.available()`: if the embedder
 * has gone down (model can't load), stop and leave rows pending for the next launch;
 * if it's still up, treat it as a one-off failure for that row — skip it (so it can't
 * wedge the loop) and leave it pending to retry next launch. Embeddings are best-effort.
 */
export async function runChatBackfill(store: ChatStore, embedder: Embedder): Promise<void> {
  if (!store.hasVectorSupport()) return;
  let processed = 0;
  let skipped = 0;
  const failedRowids: number[] = [];
  for (;;) {
    const batch = store.pendingEmbeddings(BATCH, failedRowids);
    if (batch.length === 0) break;
    for (const row of batch) {
      const vec = await embedder.embed(row.content);
      if (vec) {
        store.setEmbedding(row.id, vec);
        processed++;
      } else if (!embedder.available()) {
        if (processed) log.info('chat backfill paused (embedder unavailable)', { processed });
        return;
      } else {
        // One-off failure for this row — skip it this run so it can't block the rest.
        failedRowids.push(row.rowid);
        skipped++;
        log.warn('skipping unembeddable message (will retry next launch)', { id: row.id });
      }
      await sleep(SLEEP_MS);
    }
  }
  if (processed || skipped) log.info('backfilled chat embeddings', { processed, skipped });
}
