import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LearningsStore } from '../learnings/learnings-store';
import { runBackfill } from '../learnings/backfill';
import { EMBED_DIM, type Embedder } from '../learnings/embedder';

const TEST_DIR = join(tmpdir(), `fleet-learnings-backfill-test-${Date.now()}`);

/** Embedder that can fail one specific text, or report itself permanently down. */
class StubEmbedder implements Embedder {
  readonly dim = EMBED_DIM;
  constructor(private readonly opts: { failText?: string; down?: boolean } = {}) {}
  embed(text: string): Float32Array | null {
    if (this.opts.down) return null;
    if (this.opts.failText && text.includes(this.opts.failText)) return null;
    const v = new Float32Array(EMBED_DIM);
    v[0] = 1;
    return v;
  }
  available(): boolean {
    return !this.opts.down;
  }
}

describe('runBackfill', () => {
  let store: LearningsStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new LearningsStore(join(TEST_DIR, 'learnings.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('embeds all pending learnings when the embedder is healthy', async () => {
    store.create({ title: 'a', body: 'x' });
    store.create({ title: 'b', body: 'y' });
    await runBackfill(store, new StubEmbedder());
    expect(store.pendingEmbeddings(10)).toHaveLength(0);
  });

  it('skips an unembeddable row and still embeds the rest (no wedged loop)', async () => {
    store.create({ title: 'good one', body: 'fine' });
    const bad = store.create({ title: 'BAD row', body: 'unembeddable' });
    store.create({ title: 'good two', body: 'fine' });

    await runBackfill(store, new StubEmbedder({ failText: 'BAD' }));

    const pending = store.pendingEmbeddings(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(bad.id); // only the failing row remains, to retry next launch
  });

  it('stops and leaves every row pending when the embedder is down', async () => {
    store.create({ title: 'a', body: 'x' });
    store.create({ title: 'b', body: 'y' });
    await runBackfill(store, new StubEmbedder({ down: true }));
    expect(store.pendingEmbeddings(10)).toHaveLength(2);
  });
});
