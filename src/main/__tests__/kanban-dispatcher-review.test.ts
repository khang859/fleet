import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanDispatcher, type SpawnWorkerArgs } from '../kanban/kanban-dispatcher';

const db = (): string => join(tmpdir(), `fleet-disp-rev-${Math.random()}.db`);

function baseConfig() {
  return {
    failureLimit: 3,
    claimGraceMs: 0,
    maxInProgress: 3,
    claimTtlMs: 100000,
    autoDecompose: false,
    autoAssign: false,
    autoIntegrate: false,
    autoReview: true,
    maxDecompose: 1,
    artifactRetentionDays: 0
  };
}

function reviewable(store: KanbanStore): ReturnType<KanbanStore['getTask']> {
  const t = store.createTask({ title: 'x', status: 'review', workspaceKind: 'worktree' });
  store.setWorkspace(t.id, join(tmpdir(), 'wt'), 'b', 'main');
  return store.getTask(t.id)!;
}

describe('reviewTasks()', () => {
  it('claims a review-pending worktree task and spawns a review run', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = reviewable(store)!;
    const spawn = vi.fn<(a: SpawnWorkerArgs) => number | undefined>(() => 42);
    const disp = new KanbanDispatcher(store, {
      now: () => 1000,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig()
    });
    disp.reviewTasks();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].mode).toBe('review');
    expect(store.getTask(t.id)!.status).toBe('running');
    store.close();
  });

  it('autoReview off -> no-op', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    reviewable(store);
    const spawn = vi.fn(() => 42);
    const disp = new KanbanDispatcher(store, {
      now: () => 1000,
      isAlive: () => true,
      spawnWorker: spawn,
      config: { ...baseConfig(), autoReview: false }
    });
    disp.reviewTasks();
    expect(spawn).not.toHaveBeenCalled();
    store.close();
  });

  it('skips swarm members', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = reviewable(store)!;
    vi.spyOn(store, 'isSwarmMember').mockReturnValue(true);
    const spawn = vi.fn(() => 42);
    const disp = new KanbanDispatcher(store, {
      now: () => 1000,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig()
    });
    disp.reviewTasks();
    expect(spawn).not.toHaveBeenCalled();
    expect(store.getTask(t.id)!.status).toBe('review');
    store.close();
  });

  it('spawn failure under failureLimit -> back to review', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = reviewable(store)!;
    const spawn = vi.fn(() => {
      throw new Error('boom');
    });
    const disp = new KanbanDispatcher(store, {
      now: () => 1000,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig()
    });
    disp.reviewTasks();
    expect(store.getTask(t.id)!.status).toBe('review');
    expect(store.listEvents(t.id).some((e) => e.kind === 'spawn_failed')).toBe(true);
    store.close();
  });
});
