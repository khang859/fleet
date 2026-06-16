import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LearningsStore } from '../learnings/learnings-store';

const TEST_DIR = join(tmpdir(), `fleet-learnings-store-test-${Date.now()}`);
const DB_PATH = join(TEST_DIR, 'learnings.db');

describe('LearningsStore', () => {
  let store: LearningsStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new LearningsStore(DB_PATH);
  });

  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates the db at the current schema version', () => {
    expect(existsSync(DB_PATH)).toBe(true);
    expect(store.schemaVersion()).toBe(2);
  });

  it('creates and reads back a learning with provenance', () => {
    const l = store.create({
      title: 'node-pty needs chmod +x on spawn-helper',
      body: 'On macOS the bundled spawn-helper loses its exec bit; postinstall re-adds it.',
      tags: ['node-pty', 'macos'],
      sourceAgent: 'claude',
      sourceSessionId: 'sess-123',
      sourceCwd: '/home/me/fleet',
      sourceProject: 'fleet',
      model: 'claude-opus-4-8'
    });
    const got = store.get(l.id);
    expect(got).not.toBeNull();
    expect(got?.title).toContain('spawn-helper');
    expect(got?.tags).toEqual(['node-pty', 'macos']);
    expect(got?.sourceAgent).toBe('claude');
    expect(got?.sourceProject).toBe('fleet');
  });

  it('dedups re-creates of the same title for one source session', () => {
    const first = store.create({
      title: 'lesson from session',
      body: 'v1',
      sourceSessionId: 'sess-1'
    });
    const again = store.create({
      title: 'lesson from session',
      body: 'v2 (ignored)',
      sourceSessionId: 'sess-1'
    });
    expect(again.id).toBe(first.id);
    expect(again.body).toBe('v1'); // returns the existing row, no duplicate insert
    expect(store.search({})).toHaveLength(1);

    // Same title from a different session is NOT a duplicate.
    store.create({ title: 'lesson from session', body: 'x', sourceSessionId: 'sess-2' });
    // ...and hand-written entries (no source session) are never deduped.
    store.create({ title: 'lesson from session', body: 'x' });
    store.create({ title: 'lesson from session', body: 'x' });
    expect(store.search({})).toHaveLength(4);
  });

  it('full-text searches title and body, ignoring non-matches', () => {
    store.create({ title: 'xterm sizing inner div', body: 'fit addon miscalculates with padding' });
    store.create({ title: 'sqlite WAL mode', body: 'journal_mode improves concurrency' });

    expect(store.search({ query: 'xterm' }).map((l) => l.title)).toEqual([
      'xterm sizing inner div'
    ]);
    // prefix match on a partial token
    expect(store.search({ query: 'miscalc' })).toHaveLength(1);
    // body term hits
    expect(store.search({ query: 'journal' })).toHaveLength(1);
    expect(store.search({ query: 'nonexistentterm' })).toHaveLength(0);
  });

  it('search input with FTS operators does not throw', () => {
    store.create({ title: 'AND OR weirdness', body: 'tokens with "quotes" and * stars' });
    expect(() => store.search({ query: 'AND OR "(' })).not.toThrow();
    expect(store.search({ query: 'quotes' })).toHaveLength(1);
  });

  it('punctuation-only / CJK-only search does not throw (no empty FTS phrase)', () => {
    store.create({ title: 'alpha', body: 'one' });
    store.create({ title: 'beta', body: 'two' });
    // These collapse to no searchable tokens; FTS5 would otherwise throw on an
    // empty phrase. They degrade to the plain listing (treated like an empty box).
    for (const query of ['.', '!!! ???', '@#$%', '…', '。', '   ']) {
      expect(() => store.search({ query })).not.toThrow();
      expect(store.search({ query })).toHaveLength(2);
    }
    // A real token mixed with punctuation still searches normally.
    expect(store.search({ query: 'alpha ...' }).map((l) => l.title)).toEqual(['alpha']);
  });

  it('filters by project and tag', () => {
    store.create({ title: 'a', body: 'x', sourceProject: 'fleet', tags: ['ci'] });
    store.create({ title: 'b', body: 'x', sourceProject: 'other', tags: ['ci'] });
    store.create({ title: 'c', body: 'x', sourceProject: 'fleet', tags: ['ui'] });

    expect(store.search({ project: 'fleet' })).toHaveLength(2);
    expect(store.search({ tag: 'ci' })).toHaveLength(2);
    expect(store.search({ project: 'fleet', tag: 'ui' })).toHaveLength(1);
  });

  it('tag filter matches exact membership, not LIKE wildcards', () => {
    store.create({ title: 'a', body: 'x', tags: ['ci'] });
    store.create({ title: 'b', body: 'x', tags: ['cd'] });
    store.create({ title: 'c', body: 'x', tags: [] });

    // A literal "%" or "_" must match a tag named exactly that — never every row.
    expect(store.search({ tag: '%' })).toHaveLength(0);
    expect(store.search({ tag: '_' })).toHaveLength(0);
    // Exact membership still works and doesn't leak across similar tags.
    expect(store.search({ tag: 'ci' })).toHaveLength(1);
    expect(store.search({ tag: 'c' })).toHaveLength(0);
  });

  it('updates and keeps fts in sync', () => {
    const l = store.create({ title: 'original title', body: 'original body' });
    store.update(l.id, { title: 'renamed widget', body: 'fresh content', tags: ['t'] });

    expect(store.search({ query: 'original' })).toHaveLength(0);
    expect(store.search({ query: 'renamed' })).toHaveLength(1);
    expect(store.get(l.id)?.tags).toEqual(['t']);
  });

  it('deletes and removes from fts', () => {
    const l = store.create({ title: 'deleteme', body: 'gone soon' });
    expect(store.search({ query: 'deleteme' })).toHaveLength(1);
    store.delete(l.id);
    expect(store.get(l.id)).toBeNull();
    expect(store.search({ query: 'deleteme' })).toHaveLength(0);
    expect(store.search({})).toHaveLength(0);
  });

  it('findSimilar surfaces partial overlaps via OR matching', () => {
    store.create({ title: 'xterm container sizing with fit addon', body: 'inner div' });
    store.create({ title: 'sqlite WAL mode tuning', body: 'concurrency' });

    // Shares only some tokens, yet still matches (AND search would miss it).
    const hits = store.findSimilar('xterm sizing padding bug');
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toContain('xterm');

    expect(store.findSimilar('completely unrelated phrase')).toHaveLength(0);
    // Too-short / empty input yields nothing rather than throwing.
    expect(store.findSimilar('a b')).toEqual([]);
  });

  it('findSimilar respects the limit', () => {
    for (let i = 0; i < 5; i++) store.create({ title: `react hooks lesson ${i}`, body: 'deps' });
    expect(store.findSimilar('react hooks', 3)).toHaveLength(3);
  });

  it('allTags aggregates counts across learnings, most-used first', () => {
    store.create({ title: 'a', body: 'x', tags: ['sqlite', 'testing'] });
    store.create({ title: 'b', body: 'x', tags: ['sqlite'] });
    store.create({ title: 'c', body: 'x', tags: ['ui'] });

    expect(store.allTags()).toEqual([
      { tag: 'sqlite', count: 2 },
      { tag: 'testing', count: 1 },
      { tag: 'ui', count: 1 }
    ]);
  });

  describe('vectors (sqlite-vec)', () => {
    const vec = (fill: number): Float32Array => new Float32Array(384).fill(fill);

    it('loads the sqlite-vec extension', () => {
      expect(store.hasVectorSupport()).toBe(true);
    });

    it('refuses a mis-sized embedding instead of corrupting the vec table', () => {
      const l = store.create({ title: 'sized', body: 'x' });
      store.setEmbedding(l.id, new Float32Array(10).fill(1)); // wrong length
      expect(store.pendingEmbeddings(10).map((p) => p.id)).toEqual([l.id]); // still pending
      expect(store.vectorSearch(vec(1), 5)).toHaveLength(0); // nothing was written
    });

    it('new learnings start pending and leave the pending set once embedded', () => {
      const a = store.create({ title: 'a', body: 'x' });
      const b = store.create({ title: 'b', body: 'y' });
      expect(
        store
          .pendingEmbeddings(10)
          .map((p) => p.id)
          .sort()
      ).toEqual([a.id, b.id].sort());

      store.setEmbedding(a.id, vec(0.1));
      expect(store.pendingEmbeddings(10).map((p) => p.id)).toEqual([b.id]);
    });

    it('vectorSearch ranks the nearest learning first', () => {
      const near = store.create({ title: 'near', body: 'x' });
      const far = store.create({ title: 'far', body: 'y' });
      store.setEmbedding(near.id, vec(1));
      store.setEmbedding(far.id, vec(-1));

      const hits = store.vectorSearch(vec(0.9), 2);
      expect(hits.map((h) => h.id)).toEqual([near.id, far.id]);
      expect(hits[0].distance).toBeLessThan(hits[1].distance);
    });

    it('editing the body marks the embedding stale; a tag-only edit does not', () => {
      const l = store.create({ title: 't', body: 'b' });
      store.setEmbedding(l.id, vec(0.5));
      expect(store.pendingEmbeddings(10)).toHaveLength(0);

      store.update(l.id, { tags: ['x'] });
      expect(store.pendingEmbeddings(10)).toHaveLength(0); // tag-only: vector still fresh

      store.update(l.id, { body: 'changed' });
      expect(store.pendingEmbeddings(10).map((p) => p.id)).toEqual([l.id]);
    });

    it('delete removes the vector so it no longer matches', () => {
      const l = store.create({ title: 'gone', body: 'x' });
      store.setEmbedding(l.id, vec(1));
      expect(store.vectorSearch(vec(1), 5)).toHaveLength(1);
      store.delete(l.id);
      expect(store.vectorSearch(vec(1), 5)).toHaveLength(0);
    });

    it('pendingEmbeddings tolerates a large exclude set (no SQL variable-limit crash)', () => {
      const a = store.create({ title: 'a', body: 'x' });
      const b = store.create({ title: 'b', body: 'y' });
      // > 999 ids would overflow a `NOT IN (?, ?, …)` clause; the JS-filter path must not.
      const exclude = Array.from({ length: 1500 }, (_, i) => i + 1);
      expect(() => store.pendingEmbeddings(10, exclude)).not.toThrow();

      // And it still excludes the right rows: passing a's rowid leaves only b pending.
      const aRowid = store.pendingEmbeddings(10).find((p) => p.id === a.id)?.rowid;
      expect(aRowid).toBeDefined();
      const pending = store.pendingEmbeddings(10, [aRowid as number]).map((p) => p.id);
      expect(pending).toEqual([b.id]);
    });

    it('vectorSearch returns [] (no throw) when the vec table is empty', () => {
      // KNN over an empty vec table can throw on some sqlite-vec builds; we degrade.
      store.create({ title: 'unembedded', body: 'x' });
      expect(() => store.vectorSearch(vec(1), 5)).not.toThrow();
      expect(store.vectorSearch(vec(1), 5)).toHaveLength(0);
    });
  });

  it('search caps results at the default limit', () => {
    for (let i = 0; i < 5; i++) store.create({ title: `t${i}`, body: 'x' });
    expect(store.search({}, 3)).toHaveLength(3);
  });
});
