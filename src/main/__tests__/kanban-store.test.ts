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
});
