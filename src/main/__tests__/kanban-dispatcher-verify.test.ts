import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import {
  KanbanDispatcher,
  type SpawnWorkerArgs,
  type WorkerExit
} from '../kanban/kanban-dispatcher';

const TEST_DIR = join(tmpdir(), `fleet-disp-verify-${Date.now()}`);

function baseConfig() {
  return {
    failureLimit: 3,
    claimGraceMs: 0,
    maxInProgress: 3,
    claimTtlMs: 100000,
    autoDecompose: false,
    autoAssign: false,
    autoIntegrate: false,
    maxDecompose: 1,
    artifactRetentionDays: 0
  };
}

// A worktree task parked in 'running' with a live verify run, as kanban_complete leaves it.
function makeVerifyingTask(store: KanbanStore) {
  const t = store.createTask({
    title: 'x',
    status: 'running',
    workspaceKind: 'worktree',
    workspacePath: join(TEST_DIR, 'wt')
  });
  const work = store.startRun(t.id, 'w', 100, 'work');
  store.finishRun(work.id, 'completed', { summary: 'did the work' });
  const verify = store.startRun(t.id, null, 200, 'verify');
  store.setWorkerPid(t.id, verify.id, 200);
  return { task: store.getTask(t.id)!, verifyRunId: verify.id };
}

describe('reclaim() verify branch', () => {
  beforeEach(() => mkdirSync(join(TEST_DIR, 'wt'), { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('exit 0 -> task goes to review with the recovered work summary + verify_passed event', () => {
    const clock = { t: 5000 };
    const store = new KanbanStore(join(TEST_DIR, `a-${Math.random()}.db`), { now: () => clock.t });
    const { task, verifyRunId } = makeVerifyingTask(store);
    const exits = new Map<number, WorkerExit>([[verifyRunId, { code: 0, signal: null }]]);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: (id) => {
        exits.delete(id);
      },
      verifyLogPath: () => join(TEST_DIR, 'v.log')
    });
    disp.reclaim();
    const after = store.getTask(task.id)!;
    expect(after.status).toBe('review');
    expect(after.result).toBe('did the work');
    expect(store.listEvents(task.id).some((e) => e.kind === 'verify_passed')).toBe(true);
    store.close();
  });

  it('exit !=0 under cap -> spawns a work fix run with verifyFailure + verify_failed event', () => {
    const clock = { t: 5000 };
    const store = new KanbanStore(join(TEST_DIR, `b-${Math.random()}.db`), { now: () => clock.t });
    const { task, verifyRunId } = makeVerifyingTask(store);
    const logPath = join(TEST_DIR, 'v.log');
    writeFileSync(logPath, '=== verify: tests ===\nFAIL some.test\n');
    const exits = new Map<number, WorkerExit>([[verifyRunId, { code: 1, signal: null }]]);
    const spawn = vi.fn<(a: SpawnWorkerArgs) => number | undefined>(() => 999);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: (id) => {
        exits.delete(id);
      },
      verifyLogPath: () => logPath
    });
    disp.reclaim();
    expect(spawn).toHaveBeenCalledTimes(1);
    const arg = spawn.mock.calls[0][0];
    expect(arg.mode).toBe('work');
    expect(arg.verifyFailure).toContain('FAIL some.test');
    expect(store.getTask(task.id)?.verifyAttempts).toBe(1);
    expect(store.getTask(task.id)?.status).toBe('running');
    expect(store.listEvents(task.id).some((e) => e.kind === 'verify_failed')).toBe(true);
    store.close();
  });

  it('exit !=0 at cap -> blocked, no fix run', () => {
    const clock = { t: 5000 };
    const store = new KanbanStore(join(TEST_DIR, `c-${Math.random()}.db`), { now: () => clock.t });
    const { task, verifyRunId } = makeVerifyingTask(store);
    store.incrementVerifyAttempts(task.id); // 1
    store.incrementVerifyAttempts(task.id); // 2 == VERIFY_ATTEMPT_CAP
    const exits = new Map<number, WorkerExit>([[verifyRunId, { code: 1, signal: null }]]);
    const spawn = vi.fn(() => 999);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: (id) => {
        exits.delete(id);
      },
      verifyLogPath: () => join(TEST_DIR, 'missing.log')
    });
    disp.reclaim();
    expect(spawn).not.toHaveBeenCalled();
    expect(store.getTask(task.id)?.status).toBe('blocked');
    store.close();
  });

  it('exit==null (unknown) -> fail-open to review with verify_skipped', () => {
    const clock = { t: 5000 };
    const store = new KanbanStore(join(TEST_DIR, `d-${Math.random()}.db`), { now: () => clock.t });
    const { task } = makeVerifyingTask(store);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => false, // pid 200 "dead"
      spawnWorker: () => undefined,
      config: baseConfig(),
      workerExit: () => undefined,
      clearWorkerExit: () => undefined,
      verifyLogPath: () => join(TEST_DIR, 'v.log')
    });
    disp.reclaim();
    const after = store.getTask(task.id)!;
    expect(after.status).toBe('review');
    expect(store.listEvents(task.id).some((e) => e.kind === 'verify_skipped')).toBe(true);
    store.close();
  });

  it('verify-fix spawn failure -> reset to ready + spawn_failed event', () => {
    const clock = { t: 5000 };
    const store = new KanbanStore(join(TEST_DIR, `f-${Math.random()}.db`), { now: () => clock.t });
    const { task, verifyRunId } = makeVerifyingTask(store);
    const logPath = join(TEST_DIR, 'v.log');
    writeFileSync(logPath, '=== verify: tests ===\nFAIL\n');
    const exits = new Map<number, WorkerExit>([[verifyRunId, { code: 1, signal: null }]]);
    const spawn = vi.fn(() => {
      throw new Error('boom');
    });
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: (id) => {
        exits.delete(id);
      },
      verifyLogPath: () => logPath
    });
    disp.reclaim();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(store.getTask(task.id)?.status).toBe('ready');
    expect(store.getTask(task.id)?.verifyAttempts).toBe(1);
    expect(store.listEvents(task.id).some((e) => e.kind === 'spawn_failed')).toBe(true);
    store.close();
  });

  it('a verify run exiting code 3 routes through verify (fail), NOT review-required', () => {
    const clock = { t: 5000 };
    const store = new KanbanStore(join(TEST_DIR, `e-${Math.random()}.db`), { now: () => clock.t });
    const { task, verifyRunId } = makeVerifyingTask(store);
    const logPath = join(TEST_DIR, 'v.log');
    writeFileSync(logPath, '=== verify: tests ===\n');
    const exits = new Map<number, WorkerExit>([[verifyRunId, { code: 3, signal: null }]]);
    const spawn = vi.fn(() => 999);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: spawn,
      config: baseConfig(),
      workerExit: (id) => exits.get(id),
      clearWorkerExit: (id) => {
        exits.delete(id);
      },
      verifyLogPath: () => logPath
    });
    disp.reclaim();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(store.getTask(task.id)?.status).toBe('running');
    store.close();
  });
});
