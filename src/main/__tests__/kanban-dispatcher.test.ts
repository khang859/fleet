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
      spawnWorker: (args) => { spawned.push({ id: args.task.id, mode: args.mode }); return 4242; },
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
      spawnWorker: (args) => { spawned.push({ id: args.task.id, mode: args.mode }); return 4242; },
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
      now: () => clock.t, isAlive: () => true,
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
      now: () => clock.t, isAlive: () => true, spawnWorker: () => 1,
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
      now: () => clock.t, isAlive: () => true, spawnWorker: () => 1,
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
      now: () => clock.t, isAlive: () => true, spawnWorker: () => 1,
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
});
