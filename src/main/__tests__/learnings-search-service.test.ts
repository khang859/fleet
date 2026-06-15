import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LearningsStore } from '../learnings/learnings-store';
import { LearningsSearchService, reciprocalRankFusion } from '../learnings/search-service';
import { FakeEmbedder, NullEmbedder } from '../learnings/embedder';

const TEST_DIR = join(tmpdir(), `fleet-learnings-search-test-${Date.now()}`);

describe('reciprocalRankFusion', () => {
  it('returns an empty list for no inputs', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it('preserves order for a single list', () => {
    expect(reciprocalRankFusion([['a', 'b', 'c']])).toEqual(['a', 'b', 'c']);
  });

  it('rewards ids that rank well across both lists', () => {
    // `b` is mid in each list but appears in both → should beat list-1-only `a`.
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['c', 'b', 'd']
    ]);
    expect(fused[0]).toBe('c'); // 1st in list2, 3rd in list1
    expect(fused.indexOf('b')).toBeLessThan(fused.indexOf('a'));
  });
});

describe('LearningsSearchService.hybridSearch', () => {
  let store: LearningsStore;

  const embedAll = async (embedder: FakeEmbedder): Promise<void> => {
    for (const l of store.search({})) {
      const v = await embedder.embed(`${l.title}\n${l.body}`);
      store.setEmbedding(l.id, v);
    }
  };

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new LearningsStore(join(TEST_DIR, 'learnings.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('fuses keyword and vector hits, surfacing a semantically-related entry', async () => {
    const embedder = new FakeEmbedder();
    store.create({
      title: 'xterm fit addon miscalculates terminal dimensions',
      body: 'padding on inner div'
    });
    store.create({ title: 'sqlite WAL mode', body: 'journal_mode improves concurrency' });
    store.create({ title: 'use zod for validation', body: 'never unsafe casts' });
    await embedAll(embedder);

    const svc = new LearningsSearchService(store, embedder);
    const results = await svc.hybridSearch('terminal dimensions miscalculates', {}, 5);
    expect(results[0].title).toContain('xterm');
  });

  it('respects the limit', async () => {
    const embedder = new FakeEmbedder();
    for (let i = 0; i < 6; i++) store.create({ title: `react hooks ${i}`, body: 'deps array' });
    await embedAll(embedder);

    const svc = new LearningsSearchService(store, embedder);
    expect(await svc.hybridSearch('react hooks deps', {}, 3)).toHaveLength(3);
  });

  it('applies project/tag filters to the fused set', async () => {
    const embedder = new FakeEmbedder();
    store.create({
      title: 'caching strategy',
      body: 'lru',
      sourceProject: 'fleet',
      tags: ['perf']
    });
    store.create({
      title: 'caching strategy',
      body: 'lru',
      sourceProject: 'other',
      tags: ['perf']
    });
    await embedAll(embedder);

    const svc = new LearningsSearchService(store, embedder);
    const results = await svc.hybridSearch('caching lru', { project: 'fleet' }, 5);
    expect(results).toHaveLength(1);
    expect(results[0].sourceProject).toBe('fleet');
  });

  it('falls back to FTS-only when the embedder is unavailable', async () => {
    store.create({ title: 'xterm sizing', body: 'fit addon' });
    store.create({ title: 'unrelated', body: 'nothing' });
    const svc = new LearningsSearchService(store, new NullEmbedder());

    const results = await svc.hybridSearch('xterm', {}, 5);
    expect(results.map((l) => l.title)).toEqual(['xterm sizing']);
  });
});
