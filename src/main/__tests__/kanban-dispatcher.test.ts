import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import {
  KanbanDispatcher,
  type SpawnWorkerArgs,
  type IntegrationOps
} from '../kanban/kanban-dispatcher';

const TEST_DIR = join(tmpdir(), `fleet-kanban-disp-test-${Date.now()}`);

function makeStore(clock: { t: number }): KanbanStore {
  return new KanbanStore(join(TEST_DIR, `d-${clock.t}-${Math.random()}.db`), {
    now: () => clock.t
  });
}

describe('KanbanDispatcher.reclaim', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('returns a task with an expired claim back to ready', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'L', 100); // expires 1100
    store.startRun(t.id, 'r', 4321);
    clock.t = 2000;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      }
    });
    disp.reclaim();
    expect(store.getTask(t.id)?.status).toBe('ready');
    expect(store.getTask(t.id)?.consecutiveFailures).toBe(1);
    store.close();
  });

  it('gives up after exceeding the failure limit', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.recordFailure(t.id, 'prev');
    store.recordFailure(t.id, 'prev2'); // now at 2 == limit
    store.claimTask(t.id, 'L', 100);
    clock.t = 2000;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      }
    });
    disp.reclaim();
    expect(store.getTask(t.id)?.status).toBe('blocked');
    store.close();
  });

  it('routes a clean incomplete exit (code 3) to review-required without counting a crash', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'L', 100000); // long ttl, not expired
    const run = store.startRun(t.id, 'r', 9999);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true, // pid liveness irrelevant — a definitive exit was observed
      spawnWorker: () => undefined,
      config: { ...baseConfig, claimGraceMs: 120_000, claimTtlMs: 100000 },
      workerExit: (id) => (id === run.id ? { code: 3, signal: null } : undefined)
    });
    disp.reclaim();
    const got = store.getTask(t.id);
    expect(got?.status).toBe('blocked');
    expect(got?.result).toContain('review-required');
    expect(got?.consecutiveFailures).toBe(0); // not a crash
    expect(store.listRuns(t.id)[0].outcome).toBe('incomplete');
    store.close();
  });

  it('routes exit-3 to review-required even when the claim lease also expired', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'L', 100); // expires 1100
    const run = store.startRun(t.id, 'r', 9999);
    clock.t = 5000; // claim expired
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => false,
      spawnWorker: () => undefined,
      config: { ...baseConfig, claimGraceMs: 0, claimTtlMs: 100 },
      workerExit: (id) => (id === run.id ? { code: 3, signal: null } : undefined)
    });
    disp.reclaim();
    const got = store.getTask(t.id);
    expect(got?.status).toBe('blocked');
    expect(got?.result).toContain('review-required');
    expect(got?.consecutiveFailures).toBe(0); // expiry must not turn this into a crash
    store.close();
  });

  it('blocks immediately on a retry-proof exit (blockNow) with the real cause, no retry', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'L', 100000);
    const run = store.startRun(t.id, 'r', 9999);
    const reason = 'rune authentication failed — fix the provider credentials and retry';
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig, claimGraceMs: 120_000, claimTtlMs: 100000 },
      workerExit: (id) =>
        id === run.id ? { code: 1, signal: null, fatalReason: reason, blockNow: true } : undefined
    });
    disp.reclaim();
    const got = store.getTask(t.id);
    expect(got?.status).toBe('blocked');
    expect(got?.result).toBe(reason); // surfaced verbatim, not "pid not alive"
    expect(got?.consecutiveFailures).toBe(0); // definitive block — never entered the retry path
    expect(store.listRuns(t.id)[0].outcome).toBe('crashed');
    store.close();
  });

  it('surfaces a logged error as the reclaim reason while still retrying (no blockNow)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'L', 100000);
    const run = store.startRun(t.id, 'r', 9999);
    const reason = "status 400 — Missing required parameter: 'input[11].content'";
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig, claimGraceMs: 120_000, claimTtlMs: 100000 },
      workerExit: (id) =>
        id === run.id ? { code: 1, signal: null, fatalReason: reason, blockNow: false } : undefined
    });
    disp.reclaim();
    const got = store.getTask(t.id);
    expect(got?.status).toBe('ready'); // transient → retry (under failure limit)
    expect(got?.consecutiveFailures).toBe(1);
    expect(got?.lastFailureError).toBe(reason); // real cause, not "pid not alive"
    store.close();
  });

  it('treats a non-zero crash exit as a failure and reaps it past the grace window', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'L', 100000);
    const run = store.startRun(t.id, 'r', 9999);
    const cleared: number[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t, // still within grace, but a definitive exit short-circuits it
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig, claimGraceMs: 120_000, claimTtlMs: 100000 },
      workerExit: (id) => (id === run.id ? { code: 2, signal: null } : undefined),
      clearWorkerExit: (id) => cleared.push(id)
    });
    disp.reclaim();
    const got = store.getTask(t.id);
    expect(got?.status).toBe('ready'); // crash → retry (under failure limit)
    expect(got?.consecutiveFailures).toBe(1);
    expect(cleared).toContain(run.id);
    store.close();
  });

  it('reclaims a running task whose pid is dead even if claim not expired', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'L', 100000); // long ttl
    store.startRun(t.id, 'r', 9999);
    clock.t = 1001 + 31_000; // past the 30s grace window
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => false, // pid dead
      spawnWorker: () => undefined,
      config: {
        failureLimit: 2,
        claimGraceMs: 30_000,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      }
    });
    disp.reclaim();
    expect(store.getTask(t.id)?.status).toBe('ready');
    store.close();
  });
});

describe('KanbanDispatcher.promote', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('promotes a todo task whose parents are all done', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const p = store.createTask({ title: 'p', status: 'done' });
    const c = store.createTask({ title: 'c', status: 'todo' });
    store.addLink(p.id, c.id);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      }
    });
    disp.promote();
    expect(store.getTask(c.id)?.status).toBe('ready');
    store.close();
  });

  it('leaves a todo task blocked by an unfinished parent', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const p = store.createTask({ title: 'p', status: 'running' });
    const c = store.createTask({ title: 'c', status: 'todo' });
    store.addLink(p.id, c.id);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      }
    });
    disp.promote();
    expect(store.getTask(c.id)?.status).toBe('todo');
    store.close();
  });
});

describe('KanbanDispatcher.claimAndSpawn', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('claims a ready task, starts a run, and calls spawnWorker', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    const spawned: string[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (args) => {
        spawned.push(args.task.id);
        return 12345;
      },
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.claimAndSpawn();
    expect(spawned).toEqual([t.id]);
    expect(store.getTask(t.id)?.status).toBe('running');
    expect(store.getTask(t.id)?.workerPid).toBe(12345);
    expect(store.listRuns(t.id).length).toBe(1);
    store.close();
  });

  it('routes an explore-stage ready task with mode explore (plain task stays work)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const exp = store.createTask({
      title: 'map',
      status: 'ready',
      assignee: 'r',
      pipelineStage: 'explore'
    });
    const plain = store.createTask({ title: 'do', status: 'ready', assignee: 'r' });
    const spawned: Array<{ id: string; mode: string }> = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (args) => {
        spawned.push({ id: args.task.id, mode: args.mode });
        return 1;
      },
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.claimAndSpawn();
    expect(spawned.find((s) => s.id === exp.id)?.mode).toBe('explore');
    expect(spawned.find((s) => s.id === plain.id)?.mode).toBe('work');
    store.close();
  });

  it('respects the maxInProgress concurrency cap', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    // one already running
    const a = store.createTask({ title: 'a', status: 'ready', assignee: 'r' });
    store.claimTask(a.id, 'L', 100000);
    // two more ready
    store.createTask({ title: 'b', status: 'ready', assignee: 'r' });
    store.createTask({ title: 'c', status: 'ready', assignee: 'r' });
    let spawnCount = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => {
        spawnCount += 1;
        return 1;
      },
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 2,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.claimAndSpawn();
    expect(spawnCount).toBe(1); // 2 cap - 1 already running = 1 new
    store.close();
  });

  it('returns the task to ready and records failure when spawn throws', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => {
        throw new Error('spawn boom');
      },
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.claimAndSpawn();
    expect(store.getTask(t.id)?.status).toBe('ready');
    expect(store.getTask(t.id)?.consecutiveFailures).toBe(1);
    const runs = store.listRuns(t.id);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('finished');
    expect(runs[0].outcome).toBe('spawn_failed');
    store.close();
  });
});

const baseConfig = {
  failureLimit: 2,
  claimGraceMs: 0,
  maxInProgress: 3,
  claimTtlMs: 1000,
  autoDecompose: false,
  autoAssign: false,
  autoIntegrate: false,
  autoReview: false,
  maxDecompose: 1,
  artifactRetentionDays: 0
};

function fakeIntegration(over: Partial<IntegrationOps> = {}): IntegrationOps {
  return {
    ensureFeatureBranch: () => ({ ok: true }),
    checkMergeConflicts: () => ({ state: 'clean', files: [] }),
    mergeWorktreeToBase: () => ({ ok: true }),
    updateIntegrationBranchFromMain: () => ({ ok: true, alreadyUpToDate: true }),
    removeWorktree: () => ({ branchKept: false }),
    isBranchMerged: () => false,
    createFeaturePr: () => ({ ok: true, url: 'https://x/pull/1', number: 1 }),
    pushIntegrationBranch: () => ({ ok: true }),
    markPrReady: () => ({ ok: true }),
    headSha: () => 'sha',
    ...over
  };
}

describe('KanbanDispatcher.decompose', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('claims a flagged triage task and spawns an orchestrator run', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'big', status: 'triage' });
    store.setPendingMode(t.id, 'decompose');
    const spawned: Array<{ id: string; mode: string }> = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (args) => {
        spawned.push({ id: args.task.id, mode: args.mode });
        return 4242;
      },
      config: { ...baseConfig },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.decompose();
    expect(spawned).toEqual([{ id: t.id, mode: 'decompose' }]);
    expect(store.getTask(t.id)?.status).toBe('running');
    expect(store.getTask(t.id)?.pendingMode).toBeNull();
    store.close();
  });

  it('respects the maxDecompose cap', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    for (let i = 0; i < 3; i++) {
      const t = store.createTask({ title: `t${i}`, status: 'triage' });
      store.setPendingMode(t.id, 'decompose');
    }
    let count = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => (count++, 1),
      config: { ...baseConfig, maxDecompose: 2 },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.decompose();
    expect(count).toBe(2);
    store.close();
  });

  it('auto_decompose arms triage tasks only when enabled', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'a', status: 'triage' });
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoDecompose: true, maxDecompose: 1 },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.decompose();
    expect(store.getTask(t.id)?.status).toBe('running');
    store.close();
  });

  it('auto_decompose does not arm triage tasks when disabled', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    store.createTask({ title: 'a', status: 'triage' });
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoDecompose: false, maxDecompose: 1 },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.decompose();
    expect(store.runningTasks().length).toBe(0);
    expect(store.pendingDecomposeTasks().length).toBe(0);
    store.close();
  });

  it('re-flags a decompose task whose spawn throws so it is retried', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'big', status: 'triage' });
    store.setPendingMode(t.id, 'decompose');
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => {
        throw new Error('rune not found');
      },
      config: { ...baseConfig },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.decompose();
    const got = store.getTask(t.id);
    expect(got?.status).toBe('triage');
    expect(got?.pendingMode).toBe('decompose');
    store.close();
  });

  it('reclaim returns a dead orchestrator run to triage', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'big', status: 'triage' });
    store.setPendingMode(t.id, 'decompose');
    store.claimForDecompose(t.id, 'L', 100);
    store.startRun(t.id, 'orchestrator', 9999, 'decompose');
    clock.t = 2000; // claim expired
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig }
    });
    disp.reclaim();
    expect(store.getTask(t.id)?.status).toBe('triage');
    store.close();
  });

  it('reclaim returns a dead resolve run to review (not triage) so integrate retries it', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', workspaceKind: 'worktree' });
    store.setWorkspace(t.id, '/tmp/x', 'br-x', 'main');
    store.reviewTask(t.id, null);
    store.claimForResolve(t.id, 'L', 100); // expires 1100, moves to running
    store.startRun(t.id, 'worker', 9999, 'resolve');
    clock.t = 2000; // claim expired
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig }
    });
    disp.reclaim();
    expect(store.getTask(t.id)?.status).toBe('review');
    store.close();
  });

  it('routes a full_feature triage root to the expander, not the orchestrator', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const root = store.createTask({
      title: 'Add billing',
      status: 'triage',
      pipelineTemplate: 'full_feature'
    });
    store.setPendingMode(root.id, 'decompose');
    let spawned = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => {
        spawned += 1;
        return 1;
      },
      profileRoles: () => ['explorer', 'architect', 'qa', 'worker'],
      config: { ...baseConfig }
    });
    disp.decompose();
    expect(spawned).toBe(0); // expander runs in-process; no orchestrator spawn
    const stages = store
      .listTasks()
      .map((t) => t.pipelineStage)
      .filter(Boolean)
      .sort();
    expect(stages).toEqual(['explore', 'gate', 'qa', 'spec']);
    store.close();
  });

  it('degrades a full_feature root to the orchestrator when a required role is missing', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const root = store.createTask({
      title: 'Add billing',
      status: 'triage',
      pipelineTemplate: 'full_feature'
    });
    store.setPendingMode(root.id, 'decompose');
    const spawned: string[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (args) => {
        spawned.push(args.mode);
        return 1;
      },
      profileRoles: () => ['worker'], // missing explorer/architect/qa → expansion falls back
      config: { ...baseConfig },
      prepareWorkspaceFn: () => '/tmp/ws'
    });

    // First tick: expansion is a no-op fallback; no stages, no orchestrator spawn, root re-armed.
    disp.decompose();
    expect(spawned).toEqual([]);
    expect(
      store
        .listTasks()
        .map((t) => t.pipelineStage)
        .filter(Boolean)
    ).toEqual([]);
    expect(store.getTask(root.id)?.status).toBe('triage');
    expect(store.getTask(root.id)?.pendingMode).toBe('decompose');

    // Next tick: the marker is present, so the root falls through to the orchestrator (today's flow).
    disp.decompose();
    expect(spawned).toEqual(['decompose']);
    expect(store.getTask(root.id)?.status).toBe('running');
    store.close();
  });
});

describe('KanbanDispatcher.autoAssign', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('fast-path: a single worker profile is assigned in code, no run spawned', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    let spawned = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => (spawned++, 1),
      config: { ...baseConfig, autoAssign: true },
      workerProfileNames: () => ['solo']
    });
    disp.autoAssign();
    expect(spawned).toBe(0);
    expect(store.getTask(t.id)?.assignee).toBe('solo');
    expect(store.getTask(t.id)?.status).toBe('ready');
    store.close();
  });

  it('LLM path: with multiple profiles it spawns an assign run', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    const spawned: Array<{ id: string; mode: string }> = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (args) => {
        spawned.push({ id: args.task.id, mode: args.mode });
        return 4242;
      },
      config: { ...baseConfig, autoAssign: true },
      prepareWorkspaceFn: () => '/tmp/ws',
      workerProfileNames: () => ['alpha', 'beta']
    });
    disp.autoAssign();
    expect(spawned).toEqual([{ id: t.id, mode: 'assign' }]);
    expect(store.getTask(t.id)?.status).toBe('running');
    expect(store.getTask(t.id)?.assignee).toBeNull();
    store.close();
  });

  it('LLM path: stays below the cap (failures = cap - 1) so it spawns an assign run', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    store.recordFailure(t.id, 'a1'); // consecutiveFailures = 1 < cap (2)
    const spawned: Array<{ id: string; mode: string }> = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (args) => {
        spawned.push({ id: args.task.id, mode: args.mode });
        return 4242;
      },
      config: { ...baseConfig, autoAssign: true },
      prepareWorkspaceFn: () => '/tmp/ws',
      workerProfileNames: () => ['alpha', 'beta']
    });
    disp.autoAssign();
    expect(spawned).toEqual([{ id: t.id, mode: 'assign' }]);
    expect(store.getTask(t.id)?.status).toBe('running');
    expect(store.getTask(t.id)?.assignee).toBeNull();
    store.close();
  });

  it('fallback: after the attempt cap, assigns the first worker profile in code', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    store.recordFailure(t.id, 'a1');
    store.recordFailure(t.id, 'a2'); // consecutiveFailures = 2 == cap
    let spawned = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => (spawned++, 1),
      config: { ...baseConfig, autoAssign: true },
      prepareWorkspaceFn: () => '/tmp/ws',
      workerProfileNames: () => ['alpha', 'beta']
    });
    disp.autoAssign();
    expect(spawned).toBe(0);
    expect(store.getTask(t.id)?.assignee).toBe('alpha');
    // Assign-phase failures must be cleared so the work phase starts with a clean slate.
    expect(store.getTask(t.id)?.consecutiveFailures).toBe(0);
    store.close();
  });

  it('is a no-op when autoAssign is off', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoAssign: false },
      workerProfileNames: () => ['alpha', 'beta']
    });
    disp.autoAssign();
    expect(store.getTask(t.id)?.assignee).toBeNull();
    expect(store.getTask(t.id)?.status).toBe('ready');
    store.close();
  });

  it('is a no-op when no worker profiles exist', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoAssign: true },
      workerProfileNames: () => []
    });
    disp.autoAssign();
    expect(store.getTask(t.id)?.assignee).toBeNull();
    store.close();
  });

  it('reclaim returns a dead assign run to the unassigned ready pool', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    store.claimForAssign(t.id, 'L', 100); // expires 1100
    store.startRun(t.id, 'orchestrator', 9999, 'assign');
    clock.t = 2000; // claim expired
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig }
    });
    disp.reclaim();
    const got = store.getTask(t.id);
    expect(got?.status).toBe('ready');
    expect(got?.assignee).toBeNull();
    store.close();
  });
});

describe('KanbanDispatcher.fireSchedules', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  function makeDisp(store: KanbanStore, clock: { t: number }, spawned: number[]): KanbanDispatcher {
    return new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => {
        spawned.push(1);
        return 123;
      },
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      },
      intervalMs: 5000 // GRACE_MS = max(2*5000, 60000) = 60000
    });
  }

  it('fires a due one-shot in place (scheduled -> ready)', () => {
    const clock = { t: 1_000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'one', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'once', at: 1_000 });
    const disp = makeDisp(store, clock, []);
    disp.fireSchedules();
    expect(store.getTask(t.id)?.status).toBe('ready');
    store.close();
  });

  it('fires a due recurring template within grace: spawns an instance and advances next_run_at', () => {
    const clock = { t: 1_000_000 };
    const store = makeStore(clock);
    const tmpl = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(tmpl.id, { kind: 'interval', everyMs: 50_000 }); // next_run_at = 1_050_000
    clock.t = 1_050_001;
    const disp = makeDisp(store, clock, []);
    disp.fireSchedules();
    const instances = store
      .listTasks({ status: 'todo' })
      .filter((x) => x.scheduledFrom === tmpl.id);
    expect(instances.length).toBe(1);
    const after = store.getTask(tmpl.id)!;
    expect(after.status).toBe('scheduled');
    expect(after.nextRunAt).toBe(1_050_001 + 50_000);
    store.close();
  });

  it('realigns a missed recurring template (> grace) without spawning', () => {
    const clock = { t: 1_000_000 };
    const store = makeStore(clock);
    const tmpl = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(tmpl.id, { kind: 'interval', everyMs: 50_000 }); // next_run_at = 1_050_000
    clock.t = 1_050_000 + 70_000; // 70s late > 60s grace
    const disp = makeDisp(store, clock, []);
    disp.fireSchedules();
    const instances = store
      .listTasks({ status: 'todo' })
      .filter((x) => x.scheduledFrom === tmpl.id);
    expect(instances.length).toBe(0);
    expect(store.getTask(tmpl.id)!.nextRunAt).toBe(clock.t + 50_000);
    store.close();
  });

  it('does not fire a paused recurring template', () => {
    const clock = { t: 1_000_000 };
    const store = makeStore(clock);
    const tmpl = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(tmpl.id, { kind: 'interval', everyMs: 50_000 });
    store.pauseSchedule(tmpl.id);
    clock.t = 1_050_001;
    const spawned: number[] = [];
    const disp = makeDisp(store, clock, spawned);
    disp.fireSchedules();
    expect(
      store.listTasks({ status: 'todo' }).filter((x) => x.scheduledFrom === tmpl.id).length
    ).toBe(0);
    expect(store.getTask(tmpl.id)!.status).toBe('scheduled');
    store.close();
  });
});

describe('KanbanDispatcher.reconfigure', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('applies a new maxInProgress to the next claimAndSpawn', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    for (let i = 0; i < 3; i++)
      store.createTask({ title: `t${i}`, status: 'ready', assignee: 'r' });
    let spawned = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => ++spawned,
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 1,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      }
    });
    disp.claimAndSpawn();
    expect(spawned).toBe(1); // cap of 1

    disp.reconfigure(
      {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      },
      5000
    );
    disp.claimAndSpawn();
    expect(spawned).toBe(3); // remaining 2 ready tasks now allowed
    store.close();
  });

  it('restarts the timer only when the interval changes', () => {
    vi.useFakeTimers();
    try {
      const clock = { t: 1000 };
      const store = makeStore(clock);
      const cfg = {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 1,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      };
      const disp = new KanbanDispatcher(store, {
        now: () => clock.t,
        isAlive: () => true,
        spawnWorker: () => 1,
        config: cfg,
        intervalMs: 5000
      });
      disp.start();
      const clearSpy = vi.spyOn(global, 'clearInterval');
      const setSpy = vi.spyOn(global, 'setInterval');

      // same interval → no restart
      disp.reconfigure(cfg, 5000);
      expect(clearSpy).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();

      // changed interval → restart (stop + start)
      disp.reconfigure(cfg, 8000);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(setSpy).toHaveBeenCalledTimes(1);

      disp.stop();
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a timer when reconfigured while stopped', () => {
    vi.useFakeTimers();
    try {
      const clock = { t: 1000 };
      const store = makeStore(clock);
      const setSpy = vi.spyOn(global, 'setInterval');
      const disp = new KanbanDispatcher(store, {
        now: () => clock.t,
        isAlive: () => true,
        spawnWorker: () => 1,
        config: {
          failureLimit: 2,
          claimGraceMs: 0,
          maxInProgress: 1,
          claimTtlMs: 1000,
          autoDecompose: false,
          autoAssign: false,
          autoIntegrate: false,
          autoReview: false,
          maxDecompose: 1,
          artifactRetentionDays: 0
        },
        intervalMs: 5000
      });
      disp.reconfigure(
        {
          failureLimit: 2,
          claimGraceMs: 0,
          maxInProgress: 2,
          claimTtlMs: 1000,
          autoDecompose: false,
          autoAssign: false,
          autoIntegrate: false,
          autoReview: false,
          maxDecompose: 1,
          artifactRetentionDays: 0
        },
        8000
      );
      expect(setSpy).not.toHaveBeenCalled();
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('KanbanDispatcher.requestResolve', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('requestResolve spawns a resolve run and increments attempts', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', workspaceKind: 'worktree' });
    store.setWorkspace(t.id, '/tmp/x', 'br-x', 'main');
    store.reviewTask(t.id, null);
    const spawned: SpawnWorkerArgs[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (a) => {
        spawned.push(a);
        return 4242;
      },
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration()
    });
    disp.requestResolve(t.id);
    expect(spawned[0]?.mode).toBe('resolve');
    expect(store.getTask(t.id)!.status).toBe('running');
    expect(store.getTask(t.id)!.resolveAttempts).toBe(1);
    store.close();
  });

  it('requestResolve blocks past the attempt cap instead of spawning', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', workspaceKind: 'worktree' });
    store.setWorkspace(t.id, '/tmp/x', 'br-x', 'main');
    store.reviewTask(t.id, null);
    store.incrementResolveAttempts(t.id);
    store.incrementResolveAttempts(t.id); // at cap (2)
    const spawned: SpawnWorkerArgs[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (a) => {
        spawned.push(a);
        return 1;
      },
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration()
    });
    disp.requestResolve(t.id);
    expect(spawned).toHaveLength(0);
    expect(store.getTask(t.id)!.status).toBe('blocked');
    store.close();
  });
});

describe('KanbanDispatcher.integrate', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  function reviewFeatureTask(store: KanbanStore) {
    const f = store.createFeature({ boardId: 'default', name: 'F' });
    store.updateFeature(f.id, {
      integrationBranch: `fleet/feature-${f.id}`,
      repoPath: '/repo',
      baseBranch: 'main'
    });
    const t = store.createTask({
      title: 't',
      featureId: f.id,
      workspaceKind: 'worktree',
      repoPath: '/repo',
      baseBranch: 'main'
    });
    store.setWorkspace(t.id, '/tmp/t', 'br-t', 'main');
    store.reviewTask(t.id, null);
    return { f, t };
  }

  it('integrate: clean feature task -> merged, done, pruned, attempts reset', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { t } = reviewFeatureTask(store);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        checkMergeConflicts: () => ({ state: 'clean', files: [] }),
        mergeWorktreeToBase: () => ({ ok: true })
      })
    });
    disp.integrate();
    const got = store.getTask(t.id)!;
    expect(got.status).toBe('done');
    expect(got.worktreePruned).toBe(true);
    expect(got.resolveAttempts).toBe(0);
    store.close();
  });

  it('integrate: conflicting feature task -> resolve run spawned (not merged)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { t } = reviewFeatureTask(store);
    const spawned: SpawnWorkerArgs[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (a) => {
        spawned.push(a);
        return 7;
      },
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        checkMergeConflicts: () => ({ state: 'conflicts', files: ['a.ts'] })
      })
    });
    disp.integrate();
    expect(spawned[0]?.mode).toBe('resolve');
    expect(store.getTask(t.id)!.status).toBe('running');
    store.close();
  });

  it('integrate: autoIntegrate off -> no-op', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { t } = reviewFeatureTask(store);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoIntegrate: false },
      integration: fakeIntegration()
    });
    disp.integrate();
    expect(store.getTask(t.id)!.status).toBe('review');
    store.close();
  });

  it('integrate: conflicting task at the resolve cap -> blocked', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { t } = reviewFeatureTask(store);
    store.incrementResolveAttempts(t.id);
    store.incrementResolveAttempts(t.id); // at cap
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        checkMergeConflicts: () => ({ state: 'conflicts', files: ['a.ts'] })
      })
    });
    disp.integrate();
    expect(store.getTask(t.id)!.status).toBe('blocked');
    store.close();
  });

  it('integrate: conflict prediction errors -> task stays in review, no spawn, no merge', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { t } = reviewFeatureTask(store);
    const spawned: SpawnWorkerArgs[] = [];
    let merges = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (a) => {
        spawned.push(a);
        return 1;
      },
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        checkMergeConflicts: () => ({ state: 'error', files: [] }),
        mergeWorktreeToBase: () => {
          merges++;
          return { ok: true };
        }
      })
    });
    disp.integrate();
    expect(spawned).toHaveLength(0);
    expect(merges).toBe(0);
    expect(store.getTask(t.id)!.status).toBe('review');
    store.close();
  });

  it('integrate: clean prediction but merge races dirty -> resolve run spawned', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { t } = reviewFeatureTask(store);
    const spawned: SpawnWorkerArgs[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (a) => {
        spawned.push(a);
        return 8;
      },
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        checkMergeConflicts: () => ({ state: 'clean', files: [] }),
        mergeWorktreeToBase: () => ({ ok: false, conflict: true })
      })
    });
    disp.integrate();
    expect(spawned[0]?.mode).toBe('resolve');
    expect(store.getTask(t.id)!.status).toBe('running');
    store.close();
  });

  it('integrate: first clean merge opens a draft feature PR', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { f, t } = reviewFeatureTask(store);
    let drafted: { draft?: boolean } | null = null;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        createFeaturePr: (i) => {
          drafted = { draft: i.draft };
          return { ok: true, url: 'https://x/pull/9', number: 9 };
        }
      })
    });
    disp.integrate();
    expect(drafted).toEqual({ draft: true });
    const got = store.getFeature(f.id)!;
    expect(got.prNumber).toBe(9);
    // Single-task feature: the same tick merges the task (→ all-done) and cleanly
    // syncs the integration branch, so the just-created draft is flipped to ready.
    expect(got.prState).toBe('open');
    expect(store.getTask(t.id)!.status).toBe('done');
    store.close();
  });

  it('integrate: second merge pushes only (no second PR create)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { f } = reviewFeatureTask(store);
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft'); // PR already exists
    let created = 0;
    let pushed = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        createFeaturePr: () => {
          created++;
          return { ok: true, url: 'https://x/pull/9', number: 9 };
        },
        pushIntegrationBranch: () => {
          pushed++;
          return { ok: true };
        }
      })
    });
    disp.integrate();
    expect(created).toBe(0);
    expect(pushed).toBe(1);
    store.close();
  });

  it('integrate: no remote -> one feature_pr_skipped event, fire-once', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { f } = reviewFeatureTask(store);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        createFeaturePr: () => ({ ok: false, noRemote: true, error: 'no origin' })
      })
    });
    disp.integrate();
    expect(store.getFeature(f.id)!.prSkipNotified).toBe(true);
    const skips = store.listEvents(f.id).filter((e) => e.kind === 'feature_pr_skipped');
    expect(skips).toHaveLength(1);
    store.close();
  });

  function doneFeature(store: KanbanStore) {
    const f = store.createFeature({ boardId: 'default', name: 'F' });
    store.updateFeature(f.id, {
      integrationBranch: `fleet/feature-${f.id}`,
      repoPath: '/repo',
      baseBranch: 'main'
    });
    const a = store.createTask({
      title: 'a',
      featureId: f.id,
      status: 'done',
      repoPath: '/repo',
      baseBranch: 'main'
    });
    return { f, a };
  }

  it('integrateFeatures: all done + clean sync -> no system task, fires once', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { f } = doneFeature(store);
    let syncCalls = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        isBranchMerged: () => false, // integration ahead of base → something merged
        updateIntegrationBranchFromMain: () => {
          syncCalls++;
          return { ok: true };
        }
      })
    });
    disp.integrate();
    disp.integrate(); // second tick must NOT re-sync
    expect(syncCalls).toBe(1);
    expect(store.openSystemTask(f.id, 'feature_sync')).toBeNull();
    store.close();
  });

  it('integrateFeatures: sync conflict -> feature_sync system task spawned in resolve mode', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { f } = doneFeature(store);
    const spawned: SpawnWorkerArgs[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (a) => {
        spawned.push(a);
        return 9;
      },
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        // ahead-check on the integration branch → false (something merged);
        // synced-check would be on 'main' but no review task exists yet.
        isBranchMerged: ({ branchName }) => branchName === 'main',
        updateIntegrationBranchFromMain: () => ({ ok: false, conflict: true })
      })
    });
    disp.integrate();
    const sys = store.openSystemTask(f.id, 'feature_sync');
    expect(sys).not.toBeNull();
    expect(sys!.systemKind).toBe('feature_sync');
    expect(spawned[0]?.mode).toBe('resolve');
    expect(store.getFeature(f.id)!.mergeState).toBe('conflict');
    expect(store.featureRollup(f.id).total).toBe(1); // system task excluded
    store.close();
  });

  it('integrateFeatures: nothing merged (integration == base) -> skip', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    doneFeature(store);
    let syncCalls = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        isBranchMerged: () => true,
        updateIntegrationBranchFromMain: () => {
          syncCalls++;
          return { ok: true };
        }
      })
    });
    disp.integrate();
    expect(syncCalls).toBe(0);
    store.close();
  });

  it('integrateFeatures: sync error (no conflict) -> no system task, mergeState unchanged', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { f } = doneFeature(store);
    expect(store.getFeature(f.id)!.mergeState).toBeNull(); // baseline
    const spawned: SpawnWorkerArgs[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (a) => {
        spawned.push(a);
        return 1;
      },
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        // ahead-check on the integration branch → false (something merged).
        isBranchMerged: ({ branchName }) => branchName === 'main',
        updateIntegrationBranchFromMain: () => ({ ok: false }) // e.g. base branch not found
      })
    });
    disp.integrate();
    expect(store.openSystemTask(f.id, 'feature_sync')).toBeNull();
    expect(store.getFeature(f.id)!.mergeState).toBeNull(); // not 'conflict', not 'in_progress'
    expect(spawned).toHaveLength(0);
    store.close();
  });

  // A feature in 'conflict' whose feature_sync resolve worker has finished (status 'review').
  function conflictedFeatureWithReviewSync(store: KanbanStore) {
    const { f, a } = doneFeature(store);
    store.updateFeature(f.id, { mergeState: 'conflict' });
    const integrationBranch = `fleet/feature-${f.id}`;
    const sys = store.createTask({
      title: `Sync F with main`,
      featureId: f.id,
      systemKind: 'feature_sync',
      workspaceKind: 'worktree',
      status: 'review',
      repoPath: '/repo',
      branchName: integrationBranch,
      baseBranch: 'main'
    });
    store.setWorkspace(sys.id, '/tmp/sync', integrationBranch, 'main');
    return { f, a, sys, integrationBranch };
  }

  it('integrateFeatures: review feature_sync that synced -> completed + worktree pruned + in_progress', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { f, sys } = conflictedFeatureWithReviewSync(store);
    let removeCalls = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        // ahead-check on the integration branch → false (it's ahead of base);
        // synced-check on 'main' (base) → true (base now an ancestor of integration).
        isBranchMerged: ({ branchName }) => branchName === 'main',
        removeWorktree: () => {
          removeCalls++;
          return { branchKept: true };
        }
      })
    });
    disp.integrate();
    const got = store.getTask(sys.id)!;
    expect(got.status).toBe('done');
    expect(got.worktreePruned).toBe(true);
    expect(removeCalls).toBe(1);
    expect(store.getFeature(f.id)!.mergeState).toBe('in_progress');
    store.close();
  });

  it('integrateFeatures: review feature_sync that did NOT sync -> respawns resolve, then blocks at cap', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const { sys } = conflictedFeatureWithReviewSync(store);
    const spawned: SpawnWorkerArgs[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (args) => {
        spawned.push(args);
        return 5;
      },
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        // ahead-check false; synced-check on 'main' → false (worker did NOT merge).
        isBranchMerged: () => false
      })
    });
    // First tick: a resolve run is spawned and attempts increment.
    disp.integrate();
    expect(spawned[0]?.mode).toBe('resolve');
    expect(store.getTask(sys.id)!.resolveAttempts).toBe(1);

    // Drive to the cap: each tick the worker hands the task back to review unresolved.
    store.setStatusCleared(sys.id, 'review');
    disp.integrate(); // second resolve (attempts → 2, at cap)
    expect(store.getTask(sys.id)!.resolveAttempts).toBe(2);
    store.setStatusCleared(sys.id, 'review');
    disp.integrate(); // at cap → blocked instead of spawning
    expect(store.getTask(sys.id)!.status).toBe('blocked');
    store.close();
  });

  it('integrate: all-done + clean sync flips draft PR to ready', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'F' });
    store.updateFeature(f.id, {
      integrationBranch: `fleet/feature-${f.id}`,
      repoPath: '/repo',
      baseBranch: 'main'
    });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft');
    const t = store.createTask({
      title: 't',
      featureId: f.id,
      workspaceKind: 'worktree',
      repoPath: '/repo',
      baseBranch: 'main'
    });
    store.setWorkspace(t.id, '/tmp/t', 'br-t', 'main');
    store.reviewTask(t.id, null);
    store.completeTask(t.id, null); // feature now all-done
    let readied = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        isBranchMerged: () => false, // integration branch ahead of base -> clean-sync branch runs
        updateIntegrationBranchFromMain: () => ({ ok: true, alreadyUpToDate: true }),
        markPrReady: (i) => {
          readied = i.prNumber;
          return { ok: true };
        }
      })
    });
    disp.integrate();
    expect(readied).toBe(9);
    expect(store.getFeature(f.id)!.prState).toBe('open');
    const ev = store.listEvents(f.id).filter((e) => e.kind === 'feature_pr_ready');
    expect(ev).toHaveLength(1);
    store.close();
  });

  it('integrate: non-draft feature PR is not re-readied', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'F' });
    store.updateFeature(f.id, {
      integrationBranch: `fleet/feature-${f.id}`,
      repoPath: '/repo',
      baseBranch: 'main'
    });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'open'); // already ready
    const t = store.createTask({
      title: 't',
      featureId: f.id,
      workspaceKind: 'worktree',
      repoPath: '/repo',
      baseBranch: 'main'
    });
    store.setWorkspace(t.id, '/tmp/t', 'br-t', 'main');
    store.reviewTask(t.id, null);
    store.completeTask(t.id, null);
    let readied = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoIntegrate: true },
      integration: fakeIntegration({
        isBranchMerged: () => false,
        updateIntegrationBranchFromMain: () => ({ ok: true, alreadyUpToDate: true }),
        markPrReady: (i) => {
          readied = i.prNumber;
          return { ok: true };
        }
      })
    });
    disp.integrate();
    expect(readied).toBe(0);
    store.close();
  });
});

describe('KanbanDispatcher.detectFeatureGroups', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  function makeDisp(
    store: KanbanStore,
    clock: { t: number },
    spawn: (a: SpawnWorkerArgs) => number | undefined,
    alive: () => boolean = () => true
  ) {
    return new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: alive,
      spawnWorker: spawn,
      prepareWorkspaceFn: (t) => t.workspacePath ?? '',
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        autoAssign: false,
        autoIntegrate: false,
        autoReview: false,
        maxDecompose: 2,
        artifactRetentionDays: 0
      }
    });
  }

  it('spawns a suggest run for a repo with ≥2 ungrouped worktree tasks', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    store.createTask({
      title: 'a',
      status: 'ready',
      workspaceKind: 'worktree',
      repoPath: '/r',
      baseBranch: 'main',
      boardId: 'default'
    });
    store.createTask({
      title: 'b',
      status: 'todo',
      workspaceKind: 'worktree',
      repoPath: '/r',
      baseBranch: 'main',
      boardId: 'default'
    });
    const spawned: SpawnWorkerArgs[] = [];
    const disp = makeDisp(store, clock, (a) => {
      spawned.push(a);
      return 4321;
    });
    disp.detectFeatureGroups();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].mode).toBe('suggest');
    // a transient suggest system task was created for the repo and is now running
    expect(store.hasOpenSuggestTask('default', '/r')).toBe(true);
    store.close();
  });

  it('does not spawn twice for the same repo within the cooldown', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    store.createTask({
      title: 'a',
      status: 'ready',
      workspaceKind: 'worktree',
      repoPath: '/r',
      baseBranch: 'main',
      boardId: 'default'
    });
    store.createTask({
      title: 'b',
      status: 'ready',
      workspaceKind: 'worktree',
      repoPath: '/r',
      baseBranch: 'main',
      boardId: 'default'
    });
    let n = 0;
    const disp = makeDisp(store, clock, () => {
      n++;
      return 1;
    });
    disp.detectFeatureGroups();
    // even after the first run's system task is gone, the cooldown blocks a re-spawn
    store
      .listTasks()
      .filter((t) => t.systemKind === 'suggest')
      .forEach((t) => store.deleteTask(t.id));
    clock.t = 1000 + 60_000;
    disp.detectFeatureGroups();
    expect(n).toBe(1);
    store.close();
  });

  it('preserves a repo path containing a space (no key-split truncation)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    store.createTask({
      title: 'a',
      status: 'ready',
      workspaceKind: 'worktree',
      repoPath: '/repo with space',
      baseBranch: 'main',
      boardId: 'default'
    });
    store.createTask({
      title: 'b',
      status: 'ready',
      workspaceKind: 'worktree',
      repoPath: '/repo with space',
      baseBranch: 'main',
      boardId: 'default'
    });
    const spawned: SpawnWorkerArgs[] = [];
    const disp = makeDisp(store, clock, (a) => {
      spawned.push(a);
      return 1;
    });
    disp.detectFeatureGroups();
    expect(spawned).toHaveLength(1);
    // the un-truncated path reached the store
    expect(store.hasOpenSuggestTask('default', '/repo with space')).toBe(true);
    store.close();
  });

  it('does not spawn when a pending suggestion already exists for the repo', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    store.createTask({
      title: 'a',
      status: 'ready',
      workspaceKind: 'worktree',
      repoPath: '/r',
      baseBranch: 'main',
      boardId: 'default'
    });
    store.createTask({
      title: 'b',
      status: 'ready',
      workspaceKind: 'worktree',
      repoPath: '/r',
      baseBranch: 'main',
      boardId: 'default'
    });
    store.createSuggestion({ boardId: 'default', repoPath: '/r', name: 'x', taskIds: [] });
    let n = 0;
    const disp = makeDisp(store, clock, () => {
      n++;
      return 1;
    });
    disp.detectFeatureGroups();
    expect(n).toBe(0);
    store.close();
  });

  it('reclaim drops a dead suggest run (deletes the system task, no triage)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const sys = store.createTask({
      title: 'detect',
      status: 'review',
      boardId: 'default',
      systemKind: 'suggest',
      repoPath: '/r'
    });
    store.claimForSuggest(sys.id, 'L', 100); // expires 1100
    const run = store.startRun(sys.id, 'orchestrator', null, 'suggest');
    store.setWorkerPid(sys.id, run.id, 999);
    clock.t = 5000;
    let alive = true;
    const disp = makeDisp(
      store,
      clock,
      () => undefined,
      () => alive
    );
    // simulate a dead pid
    alive = false;
    disp.reclaim();
    expect(store.getTask(sys.id)).toBeNull();
    store.close();
  });

  it('reclaim drops a suggest run that exited 3 (deleted, never parked as blocked)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const sys = store.createTask({
      title: 'detect',
      status: 'review',
      boardId: 'default',
      systemKind: 'suggest',
      repoPath: '/r'
    });
    store.claimForSuggest(sys.id, 'L', 100000); // long ttl, not expired
    const run = store.startRun(sys.id, 'orchestrator', null, 'suggest');
    store.setWorkerPid(sys.id, run.id, 999);
    const cleared: number[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true, // pid liveness irrelevant — a definitive exit was observed
      spawnWorker: () => undefined,
      config: { ...baseConfig, claimGraceMs: 120_000, claimTtlMs: 100000 },
      workerExit: (id) => (id === run.id ? { code: 3, signal: null } : undefined),
      clearWorkerExit: (id) => cleared.push(id)
    });
    disp.reclaim();
    expect(store.getTask(sys.id)).toBeNull();
    expect(cleared).toContain(run.id);
    store.close();
  });

  it('reclaim drops a suggest run on the fatal blockNow path (deleted, never blocked)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const sys = store.createTask({
      title: 'detect',
      status: 'review',
      boardId: 'default',
      systemKind: 'suggest',
      repoPath: '/r'
    });
    store.claimForSuggest(sys.id, 'L', 100000); // long ttl, not expired
    const run = store.startRun(sys.id, 'orchestrator', null, 'suggest');
    store.setWorkerPid(sys.id, run.id, 999);
    const cleared: number[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig, claimGraceMs: 120_000, claimTtlMs: 100000 },
      workerExit: (id) =>
        id === run.id
          ? { code: 1, signal: null, fatalReason: 'auth failed', blockNow: true }
          : undefined,
      clearWorkerExit: (id) => cleared.push(id)
    });
    disp.reclaim();
    expect(store.getTask(sys.id)).toBeNull();
    expect(cleared).toContain(run.id);
    store.close();
  });
});

describe('KanbanDispatcher.raiseSpecApprovals', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('creates an approve_spec proposal when a done spec has children (autopilot OFF)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    const spec = store.createTask({ title: 'Spec', pipelineStage: 'spec', featureId: f.id });
    store.completeTask(spec.id, 'plan summary'); // status='done' + result
    const gate = store.createTask({
      title: 'Gate',
      status: 'blocked',
      pipelineStage: 'gate',
      systemKind: 'pipeline_gate',
      featureId: f.id
    });
    const child = store.createTask({
      title: 'impl',
      status: 'todo',
      pipelineStage: 'implement',
      featureId: f.id
    });
    store.addLink(spec.id, gate.id);
    store.addLink(gate.id, child.id);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig }
    });
    disp['raiseSpecApprovals']();
    const props = store.listProposals('default', { status: 'pending' });
    expect(props.map((p) => p.kind)).toContain('approve_spec');
    expect(props.find((p) => p.kind === 'approve_spec')?.targetId).toBe(gate.id);
    store.close();
  });

  it('is idempotent: a second call raises no further proposal', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    const spec = store.createTask({ title: 'Spec', pipelineStage: 'spec', featureId: f.id });
    store.completeTask(spec.id, 'plan summary');
    const gate = store.createTask({
      title: 'Gate',
      status: 'blocked',
      pipelineStage: 'gate',
      systemKind: 'pipeline_gate',
      featureId: f.id
    });
    const child = store.createTask({
      title: 'impl',
      status: 'todo',
      pipelineStage: 'implement',
      featureId: f.id
    });
    store.addLink(spec.id, gate.id);
    store.addLink(gate.id, child.id);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig }
    });
    disp['raiseSpecApprovals']();
    disp['raiseSpecApprovals']();
    expect(store.listProposals('default', { status: 'pending' })).toHaveLength(1);
    store.close();
  });

  it('blocks the spec and raises no proposal on empty fan-out', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    const spec = store.createTask({ title: 'Spec', pipelineStage: 'spec', featureId: f.id });
    store.completeTask(spec.id, null);
    const gate = store.createTask({
      title: 'Gate',
      status: 'blocked',
      pipelineStage: 'gate',
      systemKind: 'pipeline_gate',
      featureId: f.id
    });
    store.addLink(spec.id, gate.id);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig }
    });
    disp['raiseSpecApprovals']();
    expect(store.getTask(spec.id)?.status).toBe('blocked');
    expect(store.listProposals('default', { status: 'pending' })).toHaveLength(0);
    store.close();
  });
});

describe('KanbanDispatcher QA gating', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('request_changes re-arms implement children, then blocks the qa task at the cap', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    const qa = store.createTask({
      title: 'QA',
      status: 'todo',
      pipelineStage: 'qa',
      featureId: f.id
    });
    const child = store.createTask({
      title: 'impl',
      status: 'done',
      pipelineStage: 'implement',
      featureId: f.id
    });
    store.addLink(child.id, qa.id); // child -> qa (qa gates on the implement child)
    store.setQaVerdict(f.id, 'request_changes');
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig }
    });

    disp['processQaChanges'](); // attempt 1
    expect(store.getTask(child.id)?.status).toBe('ready');
    expect(store.getFeature(f.id)?.qaVerdict).toBeNull();
    expect(store.getTask(qa.id)?.status).toBe('todo');

    store.setQaVerdict(f.id, 'request_changes');
    disp['processQaChanges'](); // attempt 2 (== cap boundary)
    expect(store.getTask(qa.id)?.status).toBe('todo');

    store.setQaVerdict(f.id, 'request_changes');
    disp['processQaChanges'](); // cap exhausted -> block
    expect(store.getTask(qa.id)?.status).toBe('blocked');
    expect(store.listEvents(qa.id).filter((e) => e.kind === 'blocked')).toHaveLength(1);

    // A blocked qa task (verdict stays request_changes) must NOT be reselected on later ticks.
    store.setQaVerdict(f.id, 'request_changes');
    disp['processQaChanges'](); // no-op: the qa task is already blocked
    expect(store.listEvents(qa.id).filter((e) => e.kind === 'blocked')).toHaveLength(1);
    store.close();
  });

  it('reclaim parks a request_changes qa task as todo without recording a failure', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    const qa = store.createTask({
      title: 'QA',
      status: 'ready',
      assignee: 'qa',
      pipelineStage: 'qa',
      featureId: f.id
    });
    // Drive the qa task into the parked-running state kanban_qa_verdict('request_changes')
    // leaves behind: claimed → running, the qa run finished, and a qa_changes_requested event.
    store.claimTask(qa.id, 'L', 100000);
    const run = store.startRun(qa.id, 'qa', 4321, 'qa');
    store.setWorkerPid(qa.id, run.id, 4321);
    store.finishRun(run.id, 'completed', { summary: 'needs work' });
    store.appendEvent(qa.id, run.id, 'qa_changes_requested', { summary: 'needs work' });
    store.setQaVerdict(f.id, 'request_changes');

    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => false,
      spawnWorker: () => undefined,
      config: { ...baseConfig },
      workerExit: (id) => (id === run.id ? { code: 0, signal: null } : undefined)
    });

    disp.reclaim();
    const got = store.getTask(qa.id);
    expect(got?.status).toBe('todo'); // parked for processQaChanges, NOT failed back to ready/triage
    expect(got?.consecutiveFailures).toBe(0); // reclaim must not creep it toward giveUp
    expect(store.listEvents(qa.id).filter((e) => e.kind === 'gave_up')).toHaveLength(0);
    store.close();
  });

  it('markFeaturePrReady does NOT flip a pipeline feature whose verdict is request_changes', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({
      boardId: 'default',
      name: 'feat',
      repoPath: '/repo',
      baseBranch: 'main'
    });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft');
    store.createTask({ title: 'QA', status: 'todo', pipelineStage: 'qa', featureId: f.id });
    store.setQaVerdict(f.id, 'request_changes');
    const markPrReady = vi.fn(() => ({ ok: true as const }));
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig },
      integration: fakeIntegration({ markPrReady })
    });

    disp['markFeaturePrReady'](store.getFeature(f.id)!);
    expect(markPrReady).not.toHaveBeenCalled();
    expect(store.getFeature(f.id)?.prState).toBe('draft');
    store.close();
  });

  it('markFeaturePrReady flips a pipeline feature once QA passes', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({
      boardId: 'default',
      name: 'feat',
      repoPath: '/repo',
      baseBranch: 'main'
    });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft');
    store.createTask({ title: 'QA', status: 'done', pipelineStage: 'qa', featureId: f.id });
    store.setQaVerdict(f.id, 'pass');
    const markPrReady = vi.fn(() => ({ ok: true as const }));
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig },
      integration: fakeIntegration({ markPrReady })
    });

    disp['markFeaturePrReady'](store.getFeature(f.id)!);
    expect(markPrReady).toHaveBeenCalledTimes(1);
    expect(store.getFeature(f.id)?.prState).toBe('open');
    store.close();
  });

  it('markFeaturePrReady flips a non-pipeline feature (no qa task, null verdict)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({
      boardId: 'default',
      name: 'feat',
      repoPath: '/repo',
      baseBranch: 'main'
    });
    store.setFeaturePr(f.id, 'https://x/pull/9', 9, 'draft'); // no qa task; qaVerdict stays null
    const markPrReady = vi.fn(() => ({ ok: true as const }));
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig },
      integration: fakeIntegration({ markPrReady })
    });

    disp['markFeaturePrReady'](store.getFeature(f.id)!);
    expect(markPrReady).toHaveBeenCalledTimes(1);
    expect(store.getFeature(f.id)?.prState).toBe('open');
    store.close();
  });
});

describe('KanbanDispatcher.sweepStalePipelines', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  function makeDisp(store: KanbanStore, clock: { t: number }): KanbanDispatcher {
    return new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { ...baseConfig }
    });
  }

  it('flags an idle-past-threshold pipeline as blocked + emits the event', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    // A blocked gate (not running/ready, not settled), last updated at t=1000.
    store.createTask({
      title: 'Gate',
      status: 'blocked',
      pipelineStage: 'gate',
      systemKind: 'pipeline_gate',
      featureId: f.id
    });
    clock.t = 1000 + 25 * 60 * 60 * 1000; // 25h later, past the 24h threshold
    makeDisp(store, clock).sweepStalePipelines();
    expect(
      store
        .listEvents(f.id)
        .some((e) => e.kind === 'blocked' && e.payload?.reason === 'pipeline_stalled')
    ).toBe(true);
    store.close();
  });

  it('fires once: a second sweep does not re-emit the blocked event', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    store.createTask({
      title: 'Gate',
      status: 'blocked',
      pipelineStage: 'gate',
      systemKind: 'pipeline_gate',
      featureId: f.id
    });
    clock.t = 1000 + 25 * 60 * 60 * 1000;
    const disp = makeDisp(store, clock);
    disp.sweepStalePipelines();
    disp.sweepStalePipelines();
    const blocked = store
      .listEvents(f.id)
      .filter((e) => e.kind === 'blocked' && e.payload?.reason === 'pipeline_stalled');
    expect(blocked).toHaveLength(1);
    store.close();
  });

  it('does not flag a pipeline with a live (ready) stage task', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    store.createTask({
      title: 'Impl',
      status: 'ready',
      pipelineStage: 'implement',
      featureId: f.id
    });
    clock.t = 1000 + 25 * 60 * 60 * 1000;
    makeDisp(store, clock).sweepStalePipelines();
    expect(
      store
        .listEvents(f.id)
        .some((e) => e.kind === 'blocked' && e.payload?.reason === 'pipeline_stalled')
    ).toBe(false);
    store.close();
  });

  it('does not flag a fully-settled pipeline (all done)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    store.createTask({ title: 'Gate', status: 'done', pipelineStage: 'gate', featureId: f.id });
    store.createTask({ title: 'QA', status: 'done', pipelineStage: 'qa', featureId: f.id });
    clock.t = 1000 + 25 * 60 * 60 * 1000;
    makeDisp(store, clock).sweepStalePipelines();
    expect(
      store
        .listEvents(f.id)
        .some((e) => e.kind === 'blocked' && e.payload?.reason === 'pipeline_stalled')
    ).toBe(false);
    store.close();
  });

  it('does not flag a pipeline still within the idle window', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const f = store.createFeature({ boardId: 'default', name: 'feat' });
    store.createTask({
      title: 'Gate',
      status: 'blocked',
      pipelineStage: 'gate',
      featureId: f.id
    });
    clock.t = 1000 + 23 * 60 * 60 * 1000; // 23h — under the 24h threshold
    makeDisp(store, clock).sweepStalePipelines();
    expect(
      store
        .listEvents(f.id)
        .some((e) => e.kind === 'blocked' && e.payload?.reason === 'pipeline_stalled')
    ).toBe(false);
    store.close();
  });
});
