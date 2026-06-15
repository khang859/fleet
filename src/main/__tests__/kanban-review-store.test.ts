import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';

const db = () => join(tmpdir(), `fleet-review-${Math.random()}.db`);

describe('review schema (migration 15)', () => {
  it('is at schema version 15 with review columns defaulting correctly', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    expect(store.schemaVersion()).toBe(15);
    const t = store.createTask({ title: 'x' });
    const got = store.getTask(t.id)!;
    expect(got.reviewVerdict).toBeNull();
    expect(got.reviewAttempts).toBe(0);
    expect(got.reviewHeadSha).toBeNull();
    store.close();
  });
});

describe('review store methods', () => {
  it('claimForReview flips a review task to running, CAS on status', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = store.createTask({ title: 'x', status: 'review', workspaceKind: 'worktree' });
    expect(store.claimForReview(t.id, 'L1', 10000)).toBe(true);
    expect(store.getTask(t.id)!.status).toBe('running');
    expect(store.getTask(t.id)!.claimLock).toBe('L1');
    expect(store.claimForReview(t.id, 'L2', 10000)).toBe(false);
    store.close();
  });

  it('setReviewVerdict / increment / reset / clear', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = store.createTask({ title: 'x' });
    store.setReviewVerdict(t.id, 'approve', 'abc123');
    expect(store.getTask(t.id)!.reviewVerdict).toBe('approve');
    expect(store.getTask(t.id)!.reviewHeadSha).toBe('abc123');
    store.incrementReviewAttempts(t.id);
    store.incrementReviewAttempts(t.id);
    expect(store.getTask(t.id)!.reviewAttempts).toBe(2);
    store.resetReviewAttempts(t.id);
    expect(store.getTask(t.id)!.reviewAttempts).toBe(0);
    // clearReviewVerdict must null verdict+sha but PRESERVE attempts
    store.incrementReviewAttempts(t.id); // attempts = 1
    store.setReviewVerdict(t.id, 'request_changes');
    store.clearReviewVerdict(t.id);
    expect(store.getTask(t.id)!.reviewVerdict).toBeNull();
    expect(store.getTask(t.id)!.reviewHeadSha).toBeNull();
    expect(store.getTask(t.id)!.reviewAttempts).toBe(1); // preserved
    store.close();
  });

  it('reviewPendingTasks selects review worktree tasks with no verdict, skips system/scratch/verdicted', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const ok = store.createTask({ title: 'ok', status: 'review', workspaceKind: 'worktree' });
    store.setWorkspace(ok.id, '/tmp/wt', 'b', 'main');
    store.createTask({ title: 'scratch', status: 'review', workspaceKind: 'scratch' });
    const sys = store.createTask({ title: 'sys', status: 'review', workspaceKind: 'worktree', systemKind: 'feature_sync' });
    store.setWorkspace(sys.id, '/tmp/wt2', 'b', 'main');
    const verdicted = store.createTask({ title: 'v', status: 'review', workspaceKind: 'worktree' });
    store.setWorkspace(verdicted.id, '/tmp/wt3', 'b', 'main');
    store.setReviewVerdict(verdicted.id, 'approve', 'sha');
    const ids = store.reviewPendingTasks().map((t) => t.id);
    expect(ids).toContain(ok.id);
    expect(ids).not.toContain(sys.id);
    expect(ids).not.toContain(verdicted.id);
    store.close();
  });

  it('orchestratorRunningCount excludes review runs', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = store.createTask({ title: 'x', status: 'running' });
    const run = store.startRun(t.id, 'reviewer', 1, 'review');
    store.setWorkerPid(t.id, run.id, 1);
    expect(store.orchestratorRunningCount()).toBe(0);
    store.close();
  });

  it('isSwarmMember is false for an ordinary task and does not hang on a link cycle', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    store.addLink(a.id, b.id);
    store.addLink(b.id, a.id); // cycle
    expect(store.isSwarmMember(b.id)).toBe(false);
    store.close();
  });
});
