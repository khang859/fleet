import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
      config: { failureLimit: 2, claimGraceMs: 0 }
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
      config: { failureLimit: 2, claimGraceMs: 0 }
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
      config: { failureLimit: 2, claimGraceMs: 30_000 }
    });
    disp.reclaim();
    expect(store.getTask(t.id)?.status).toBe('ready');
    store.close();
  });
});
