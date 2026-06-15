import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import {
  KanbanDispatcher,
  type IntegrationOps,
  type SpawnWorkerArgs,
  type WorkerExit
} from '../kanban/kanban-dispatcher';

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

// A task parked 'running' with a finished review run, as kanban_review_verdict leaves it.
function reviewing(store: KanbanStore, verdict: 'approve' | 'request_changes' | null) {
  const t = store.createTask({ title: 'x', status: 'running', workspaceKind: 'worktree' });
  store.setWorkspace(t.id, join(tmpdir(), 'wt'), 'b', 'main');
  const run = store.startRun(t.id, 'reviewer', 7, 'review');
  store.setWorkerPid(t.id, run.id, 7);
  if (verdict) store.setReviewVerdict(t.id, verdict, verdict === 'approve' ? 'sha1' : null);
  return { task: store.getTask(t.id)!, runId: run.id };
}

describe('reclaim() review branch', () => {
  it('approve -> review, verdict + head sha kept, attempts reset', () => {
    const store = new KanbanStore(db(), { now: () => 5000 });
    const { task, runId } = reviewing(store, 'approve');
    store.incrementReviewAttempts(task.id);
    const exits = new Map<number, WorkerExit>([[runId, { code: 0, signal: null }]]);
    const disp = new KanbanDispatcher(store, {
      now: () => 5000,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: () => undefined
    });
    disp.reclaim();
    const after = store.getTask(task.id)!;
    expect(after.status).toBe('review');
    expect(after.reviewVerdict).toBe('approve');
    expect(after.reviewHeadSha).toBe('sha1');
    expect(after.reviewAttempts).toBe(0);
    store.close();
  });

  it('request_changes under cap -> spawns a work fix run with reviewFindings + clears verdict', () => {
    const store = new KanbanStore(db(), { now: () => 5000 });
    const { task, runId } = reviewing(store, 'request_changes');
    store.appendEvent(task.id, runId, 'review_changes_requested', {
      summary: 's',
      findings: [{ file: 'a.ts', note: 'null check' }]
    });
    const exits = new Map<number, WorkerExit>([[runId, { code: 0, signal: null }]]);
    const spawn = vi.fn<(a: SpawnWorkerArgs) => number | undefined>(() => 99);
    const disp = new KanbanDispatcher(store, {
      now: () => 5000,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: () => undefined
    });
    disp.reclaim();
    expect(spawn).toHaveBeenCalledTimes(1);
    const arg = spawn.mock.calls[0][0];
    expect(arg.mode).toBe('work');
    expect(arg.reviewFindings).toContain('null check');
    const after = store.getTask(task.id)!;
    expect(after.reviewAttempts).toBe(1);
    expect(after.reviewVerdict).toBeNull();
    expect(after.status).toBe('running');
    store.close();
  });

  it('request_changes at cap -> soft-escalate to review with review_escalated', () => {
    const store = new KanbanStore(db(), { now: () => 5000 });
    const { task, runId } = reviewing(store, 'request_changes');
    store.incrementReviewAttempts(task.id);
    store.incrementReviewAttempts(task.id); // == REVIEW_ATTEMPT_CAP
    const exits = new Map<number, WorkerExit>([[runId, { code: 0, signal: null }]]);
    const spawn = vi.fn(() => 99);
    const disp = new KanbanDispatcher(store, {
      now: () => 5000,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: () => undefined
    });
    disp.reclaim();
    expect(spawn).not.toHaveBeenCalled();
    const after = store.getTask(task.id)!;
    expect(after.status).toBe('review');
    expect(after.reviewVerdict).toBe('request_changes');
    expect(store.listEvents(task.id).some((e) => e.kind === 'review_escalated')).toBe(true);
    store.close();
  });

  it('inconclusive (no verdict) -> soft-escalate', () => {
    const store = new KanbanStore(db(), { now: () => 5000 });
    const { task, runId } = reviewing(store, null);
    const exits = new Map<number, WorkerExit>([[runId, { code: 3, signal: null }]]);
    const disp = new KanbanDispatcher(store, {
      now: () => 5000,
      isAlive: () => false,
      spawnWorker: () => undefined,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: () => undefined
    });
    disp.reclaim();
    const after = store.getTask(task.id)!;
    expect(after.status).toBe('review');
    expect(store.listEvents(task.id).some((e) => e.kind === 'review_escalated')).toBe(true);
    store.close();
  });

  it('exit==null but reviewer pid alive (long review) -> stays running, claim re-extended', () => {
    const store = new KanbanStore(db(), { now: () => 5000 });
    const { task } = reviewing(store, null);
    store.claimForVerifyFix(task.id, 'L', 100000);
    store.extendClaim(task.id, 'L', -1); // force-expire, lock retained
    const spawn = vi.fn(() => 99);
    const disp = new KanbanDispatcher(store, {
      now: () => 5000,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig(),
      workerExit: () => undefined,
      clearWorkerExit: () => undefined
    });
    disp.reclaim();
    expect(store.getTask(task.id)!.status).toBe('running');
    expect(spawn).not.toHaveBeenCalled();
    store.close();
  });
});

describe('integrate() review guard', () => {
  // Mirrors the real reviewFeatureTask helper in kanban-dispatcher.test.ts (a review-pending
  // feature worktree task that integrateTasks() will pick up), then layers a review verdict on top.
  function featureReviewTask(
    store: KanbanStore,
    verdict: 'approve' | 'request_changes' | null,
    sha: string | null
  ) {
    const f = store.createFeature({ boardId: 'default', name: 'F' });
    store.updateFeature(f.id, {
      integrationBranch: `fleet/feature-${f.id}`,
      repoPath: '/repo',
      baseBranch: 'main'
    });
    const t = store.createTask({
      title: 'x',
      featureId: f.id,
      workspaceKind: 'worktree',
      repoPath: '/repo',
      baseBranch: 'main'
    });
    store.setWorkspace(t.id, '/repo/wt', 'feat', 'main');
    store.reviewTask(t.id, null);
    if (verdict) store.setReviewVerdict(t.id, verdict, sha);
    return store.getTask(t.id)!;
  }

  const ops = (over: Partial<IntegrationOps> = {}): IntegrationOps => ({
    ensureFeatureBranch: () => ({ ok: true }),
    checkMergeConflicts: () => ({ state: 'clean', files: [] }),
    mergeWorktreeToBase: vi.fn(() => ({ ok: true })),
    updateIntegrationBranchFromMain: () => ({ ok: true, alreadyUpToDate: true }),
    removeWorktree: () => ({ branchKept: false }),
    isBranchMerged: () => true,
    createFeaturePr: () => ({ ok: true, url: 'https://x/pull/1', number: 1 }),
    pushIntegrationBranch: () => ({ ok: true }),
    markPrReady: () => ({ ok: true }),
    headSha: () => 'sha1',
    ...over
  });

  it('autoReview on + verdict != approve -> NOT merged', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    featureReviewTask(store, 'request_changes', null);
    const merge = vi.fn(() => ({ ok: true }));
    const disp = new KanbanDispatcher(store, {
      now: () => 1000,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig(), autoIntegrate: true },
      integration: ops({ mergeWorktreeToBase: merge })
    });
    disp.integrate();
    expect(merge).not.toHaveBeenCalled();
    store.close();
  });

  it('approve + matching HEAD -> merged', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    featureReviewTask(store, 'approve', 'sha1');
    const merge = vi.fn(() => ({ ok: true }));
    const disp = new KanbanDispatcher(store, {
      now: () => 1000,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig(), autoIntegrate: true },
      integration: ops({ mergeWorktreeToBase: merge })
    });
    disp.integrate();
    expect(merge).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('approve but HEAD drifted -> verdict cleared, NOT merged', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    const t = featureReviewTask(store, 'approve', 'OLDsha');
    const merge = vi.fn(() => ({ ok: true }));
    const disp = new KanbanDispatcher(store, {
      now: () => 1000,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig(), autoIntegrate: true },
      integration: ops({ headSha: () => 'NEWsha', mergeWorktreeToBase: merge })
    });
    disp.integrate();
    expect(merge).not.toHaveBeenCalled();
    expect(store.getTask(t.id)!.reviewVerdict).toBeNull();
    store.close();
  });
});
