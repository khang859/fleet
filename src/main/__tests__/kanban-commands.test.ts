import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanDispatcher } from '../kanban/kanban-dispatcher';
import { KanbanCommands } from '../kanban/kanban-commands';

const TEST_DIR = join(tmpdir(), `fleet-kanban-cmds-${process.pid}`);

function makeCommands(): { store: KanbanStore; commands: KanbanCommands } {
  const store = new KanbanStore(join(TEST_DIR, `cmds-${Math.random().toString(36).slice(2)}.db`));
  const dispatcher = new KanbanDispatcher(store, {
    now: () => 0,
    isAlive: () => true,
    spawnWorker: () => undefined,
    config: { failureLimit: 2, claimGraceMs: 0, maxInProgress: 3, claimTtlMs: 1000 }
  });
  const commands = new KanbanCommands(store, dispatcher, () => ({
    workspaceKind: 'worktree',
    maxRuntimeSeconds: null
  }));
  return { store, commands };
}

describe('KanbanCommands create/list/show', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('create inserts a task, applies defaults, and appends task_created', () => {
    const { store, commands } = makeCommands();
    const task = commands.create({ title: 'First task' });
    expect(task.title).toBe('First task');
    expect(task.workspaceKind).toBe('worktree');
    const events = store.listEvents(task.id);
    expect(events.map((e) => e.kind)).toContain('task_created');
  });

  it('list returns board cards, filtered by status when given', () => {
    const { commands } = makeCommands();
    commands.create({ title: 'a', status: 'ready' });
    commands.create({ title: 'b', status: 'todo' });
    expect(commands.list().length).toBe(2);
    const ready = commands.list({ status: 'ready' });
    expect(ready.length).toBe(1);
    expect(ready[0].title).toBe('a');
  });

  it('show returns task detail; null for unknown id', () => {
    const { commands } = makeCommands();
    const task = commands.create({ title: 'detail me' });
    const detail = commands.show(task.id);
    expect(detail?.task.title).toBe('detail me');
    expect(detail?.comments).toEqual([]);
    expect(commands.show('nope')).toBeNull();
  });
});
