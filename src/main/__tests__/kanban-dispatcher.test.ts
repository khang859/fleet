import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanDispatcher } from '../kanban/kanban-dispatcher';

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
        maxDecompose: 1
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
        maxDecompose: 1
      }
    });
    disp.reclaim();
    expect(store.getTask(t.id)?.status).toBe('blocked');
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
        maxDecompose: 1
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
        maxDecompose: 1
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
        maxDecompose: 1
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
        maxDecompose: 1
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
        maxDecompose: 1
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
        maxDecompose: 1
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
  maxDecompose: 1
};

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
        maxDecompose: 1
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
        maxDecompose: 1
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
        maxDecompose: 1
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
          maxDecompose: 1
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
          maxDecompose: 1
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
