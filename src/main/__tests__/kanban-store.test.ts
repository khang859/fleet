import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';

const TEST_DIR = join(tmpdir(), `fleet-kanban-store-test-${Date.now()}`);
const DB_PATH = join(TEST_DIR, 'kanban.db');

describe('KanbanStore', () => {
  let store: KanbanStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(DB_PATH);
  });

  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates the db file and runs migrations', () => {
    expect(existsSync(DB_PATH)).toBe(true);
    expect(store.schemaVersion()).toBe(1);
  });

  it('creates a task with defaults and reads it back', () => {
    const task = store.createTask({ title: 'Write docs' });
    expect(task.id).toMatch(/.+/);
    expect(task.title).toBe('Write docs');
    expect(task.status).toBe('todo');
    expect(task.priority).toBe(0);
    expect(task.skills).toEqual([]);
    expect(task.maxRetries).toBe(1);

    const fetched = store.getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe('Write docs');
  });

  it('honors explicit fields and json skills round-trip', () => {
    const task = store.createTask({
      title: 'Build',
      body: 'do it',
      assignee: 'researcher',
      status: 'triage',
      priority: 5,
      skills: ['a', 'b']
    });
    const fetched = store.getTask(task.id);
    expect(fetched?.assignee).toBe('researcher');
    expect(fetched?.status).toBe('triage');
    expect(fetched?.priority).toBe(5);
    expect(fetched?.skills).toEqual(['a', 'b']);
  });

  it('lists tasks filtered by status', () => {
    store.createTask({ title: 'a', status: 'todo' });
    store.createTask({ title: 'b', status: 'ready' });
    expect(store.listTasks().length).toBe(2);
    expect(store.listTasks({ status: 'ready' }).length).toBe(1);
  });

  it('getTask returns null for unknown id', () => {
    expect(store.getTask('nope')).toBeNull();
  });

  it('links parent->child and reads parents/children', () => {
    const p = store.createTask({ title: 'parent' });
    const c = store.createTask({ title: 'child' });
    store.addLink(p.id, c.id);
    expect(store.parentsOf(c.id)).toEqual([p.id]);
    expect(store.childrenOf(p.id)).toEqual([c.id]);
  });

  it('promotableTodoTasks returns todo tasks whose parents are all done', () => {
    const p = store.createTask({ title: 'parent', status: 'done' });
    const c = store.createTask({ title: 'child', status: 'todo' });
    store.addLink(p.id, c.id);
    expect(store.promotableTodoTasks().map((t) => t.id)).toContain(c.id);
  });

  it('does not promote a todo task with an unfinished parent', () => {
    const p = store.createTask({ title: 'parent', status: 'running' });
    const c = store.createTask({ title: 'child', status: 'todo' });
    store.addLink(p.id, c.id);
    expect(store.promotableTodoTasks().map((t) => t.id)).not.toContain(c.id);
  });

  it('promotes a todo task with no parents', () => {
    const c = store.createTask({ title: 'orphan', status: 'todo' });
    expect(store.promotableTodoTasks().map((t) => t.id)).toContain(c.id);
  });

  it('claims a ready task and prevents a second claim', () => {
    const t = store.createTask({ title: 'x', status: 'ready' });
    const first = store.claimTask(t.id, 'lock-A', 1000);
    expect(first).toBe(true);
    const second = store.claimTask(t.id, 'lock-B', 1000);
    expect(second).toBe(false);
    const fetched = store.getTask(t.id);
    expect(fetched?.status).toBe('running');
    expect(fetched?.claimLock).toBe('lock-A');
  });

  it('re-claims a task whose claim has expired', () => {
    let clock = 1000;
    const s = new KanbanStore(join(TEST_DIR, 'claim.db'), { now: () => clock });
    const t = s.createTask({ title: 'x', status: 'ready' });
    expect(s.claimTask(t.id, 'lock-A', 100)).toBe(true); // expires at 1100
    clock = 1200; // past expiry
    // expired claims are reclaimable: pretend the dispatcher returned it to ready
    s.returnToReady(t.id);
    expect(s.claimTask(t.id, 'lock-B', 100)).toBe(true);
    s.close();
  });

  it('extendClaim pushes claim_expires forward only for the lock holder', () => {
    let clock = 1000;
    const s = new KanbanStore(join(TEST_DIR, 'extend.db'), { now: () => clock });
    const t = s.createTask({ title: 'x', status: 'ready' });
    s.claimTask(t.id, 'lock-A', 100);
    clock = 1050;
    expect(s.extendClaim(t.id, 'lock-A', 100)).toBe(true);
    expect(s.getTask(t.id)?.claimExpires).toBe(1150);
    expect(s.extendClaim(t.id, 'wrong-lock', 100)).toBe(false);
    s.close();
  });
});
