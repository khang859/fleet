import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { PrPoller } from '../kanban/pr-poller';
import type { PrFetchResult } from '../kanban/workspace';

const TEST_DIR = join(tmpdir(), `fleet-pr-poller-test-${Date.now()}`);

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('PrPoller feature sweep', () => {
  it('writes feature prState/checksState from gh and emits feature_pr_synced', () => {
    const clock = 100_000;
    const store = new KanbanStore(join(TEST_DIR, `feat-sweep-${Math.random()}.db`), {
      now: () => clock
    });
    const f = store.createFeature({ boardId: 'default', name: 'F', repoPath: '/repo' });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft');
    const fetchPrState = (): PrFetchResult => ({
      ok: true,
      state: 'open',
      checksState: 'passing',
      mergeState: 'CLEAN',
      url: 'https://x/pull/9',
      number: 9
    });
    const poller = new PrPoller(store, { now: () => clock, fetchPrState });
    poller.sweep();
    const got = store.getFeature(f.id)!;
    expect(got.prState).toBe('open');
    expect(got.checksState).toBe('passing');
    expect(store.listEvents(f.id).some((e) => e.kind === 'feature_pr_synced')).toBe(true);
    store.close();
  });

  it('does not emit feature_pr_synced when polled state is unchanged', () => {
    const clock = 200_000;
    const store = new KanbanStore(join(TEST_DIR, `feat-noop-${Math.random()}.db`), {
      now: () => clock
    });
    const f = store.createFeature({ boardId: 'default', name: 'F', repoPath: '/repo' });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'open');
    store.setFeaturePrStatus(f.id, { prState: 'open', checksState: 'passing' });
    // seed pr_synced_at into the past so the feature is due again
    const fetchPrState = (): PrFetchResult => ({
      ok: true,
      state: 'open',
      checksState: 'passing',
      mergeState: 'CLEAN',
      url: 'https://x/pull/9',
      number: 9
    });
    const poller = new PrPoller(store, { now: () => clock + 100_000, fetchPrState });
    poller.sweep();
    expect(store.listEvents(f.id).filter((e) => e.kind === 'feature_pr_synced')).toHaveLength(0);
    store.close();
  });

  it('clears prState and emits exactly one null feature_pr_synced when the PR is notFound (no re-poll spin)', () => {
    let clock = 300_000;
    const store = new KanbanStore(join(TEST_DIR, `feat-gone-${Math.random()}.db`), {
      now: () => clock
    });
    const f = store.createFeature({ boardId: 'default', name: 'F', repoPath: '/repo' });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'open');
    const fetchPrState = (): PrFetchResult => ({
      ok: false,
      notFound: true,
      error: 'not found'
    });
    const poller = new PrPoller(store, { now: () => clock, fetchPrState });
    poller.sweep();
    const got = store.getFeature(f.id)!;
    expect(got.prState).toBeNull();
    const synced = store.listEvents(f.id).filter((e) => e.kind === 'feature_pr_synced');
    expect(synced).toHaveLength(1);
    expect(synced[0].payload).toEqual({ state: null });
    // Advance well past the sync gap so the feature would be time-due again; the
    // null pr_state must now exclude it from featuresDuePrSync -> no second event.
    clock += 100_000;
    poller.sweep();
    expect(store.listEvents(f.id).filter((e) => e.kind === 'feature_pr_synced')).toHaveLength(1);
    store.close();
  });

  it('flips a merged feature to shipped and emits feature_shipped exactly once', () => {
    const clock = 400_000;
    const store = new KanbanStore(join(TEST_DIR, `feat-shipped-${Math.random()}.db`), {
      now: () => clock
    });
    const f = store.createFeature({ boardId: 'default', name: 'F', repoPath: '/repo' });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'open');
    const fetchPrState = (): PrFetchResult => ({
      ok: true,
      state: 'merged',
      checksState: 'passing',
      mergeState: 'CLEAN',
      url: 'https://x/pull/9',
      number: 9
    });
    const poller = new PrPoller(store, { now: () => clock, fetchPrState });
    poller.sweep();

    const got = store.getFeature(f.id)!;
    expect(got.status).toBe('shipped');
    const shipped = store.listEvents(f.id).filter((e) => e.kind === 'feature_shipped');
    expect(shipped).toHaveLength(1);
    expect(shipped[0].payload).toEqual({ prNumber: 9 });

    // A shipped feature is no longer open/draft, so featuresDuePrSync excludes it:
    // a second sweep must not re-ship or re-emit.
    poller.sweep();
    expect(store.listEvents(f.id).filter((e) => e.kind === 'feature_shipped')).toHaveLength(1);
    store.close();
  });

  it('does not ship a feature whose PR is merely open', () => {
    const clock = 500_000;
    const store = new KanbanStore(join(TEST_DIR, `feat-open-${Math.random()}.db`), {
      now: () => clock
    });
    const f = store.createFeature({ boardId: 'default', name: 'F', repoPath: '/repo' });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft');
    const fetchPrState = (): PrFetchResult => ({
      ok: true,
      state: 'open',
      checksState: 'passing',
      mergeState: 'CLEAN',
      url: 'https://x/pull/9',
      number: 9
    });
    const poller = new PrPoller(store, { now: () => clock, fetchPrState });
    poller.sweep();

    expect(store.getFeature(f.id)!.status).toBe('active');
    expect(store.listEvents(f.id).filter((e) => e.kind === 'feature_shipped')).toHaveLength(0);
    store.close();
  });
});
