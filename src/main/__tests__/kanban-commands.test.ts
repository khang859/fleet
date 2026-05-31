import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanDispatcher } from '../kanban/kanban-dispatcher';
import { KanbanCommands } from '../kanban/kanban-commands';
import type { TaskStatus } from '../../shared/kanban-types';

const TEST_DIR = join(tmpdir(), `fleet-kanban-cmds-${process.pid}`);

function makeCommands(): { store: KanbanStore; commands: KanbanCommands } {
  const store = new KanbanStore(join(TEST_DIR, `cmds-${Math.random().toString(36).slice(2)}.db`));
  const dispatcher = new KanbanDispatcher(store, {
    now: () => 0,
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

describe('KanbanCommands status + assign', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('setManualStatus moves a non-running task and logs status_changed', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x', status: 'todo' });
    commands.setManualStatus(t.id, 'ready');
    expect(store.getTask(t.id)?.status).toBe('ready');
    const kinds = store.listEvents(t.id).map((e) => e.kind);
    expect(kinds).toContain('status_changed');
  });

  it('setManualStatus rejects moving a running task', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x', status: 'running' });
    expect(() => commands.setManualStatus(t.id, 'ready')).toThrowError(/running/);
    expect(store.getTask(t.id)?.status).toBe('running');
  });

  it('setManualStatus rejects an unknown id and an invalid status', () => {
    const { commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    expect(() => commands.setManualStatus('missing', 'ready')).toThrowError(/not found/);
    expect(() => commands.setManualStatus(t.id, 'running')).toThrowError(/cannot manually/);
  });

  it('setManualStatus rejects a non-manual status', () => {
    const { commands } = makeCommands();
    const t = commands.create({ title: 'x', status: 'todo' });
    expect(() => commands.setManualStatus(t.id, 'bogus' as TaskStatus)).toThrowError(
      /invalid status/
    );
  });

  it('block sets blocked with a reason; complete sets done with a result', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x', status: 'todo' });
    commands.block(t.id, 'waiting on design');
    expect(store.getTask(t.id)?.status).toBe('blocked');
    expect(store.getTask(t.id)?.result).toBe('waiting on design');
    const blockEvt = store.listEvents(t.id).find((e) => e.kind === 'status_changed');
    expect(blockEvt?.payload).toMatchObject({ to: 'blocked', reason: 'waiting on design' });
    const t2 = commands.create({ title: 'y', status: 'todo' });
    commands.complete(t2.id, 'shipped');
    expect(store.getTask(t2.id)?.status).toBe('done');
    expect(store.getTask(t2.id)?.result).toBe('shipped');
  });

  it('block and complete reject running tasks', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x', status: 'running' });
    expect(() => commands.block(t.id, 'r')).toThrowError(/running/);
    expect(store.getTask(t.id)?.status).toBe('running');
    expect(() => commands.complete(t.id, 'r')).toThrowError(/running/);
    expect(store.getTask(t.id)?.status).toBe('running');
  });

  it('assign sets the assignee and logs task_updated', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    commands.assign(t.id, 'orchestrator');
    expect(store.getTask(t.id)?.assignee).toBe('orchestrator');
    expect(store.listEvents(t.id).map((e) => e.kind)).toContain('task_updated');
  });
});

describe('KanbanCommands comment/link/log/dispatch', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('comment adds a human comment and logs comment_added', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    const c = commands.comment(t.id, 'looks good');
    expect(c.author).toBe('human');
    expect(store.listComments(t.id)[0].body).toBe('looks good');
    expect(store.listEvents(t.id).map((e) => e.kind)).toContain('comment_added');
  });

  it('link and unlink wire parent/child and log events on the child', () => {
    const { store, commands } = makeCommands();
    const parent = commands.create({ title: 'parent' });
    const child = commands.create({ title: 'child' });
    commands.link(parent.id, child.id);
    expect(store.childrenOf(parent.id)).toContain(child.id);
    expect(store.listEvents(child.id).map((e) => e.kind)).toContain('link_added');
    commands.unlink(parent.id, child.id);
    expect(store.childrenOf(parent.id)).not.toContain(child.id);
    expect(store.listEvents(child.id).map((e) => e.kind)).toContain('link_removed');
  });

  it('comment/link reject unknown ids', () => {
    const { commands } = makeCommands();
    expect(() => commands.comment('nope', 'hi')).toThrowError(/not found/);
    expect(() => commands.link('nope', 'also-nope')).toThrowError(/not found/);
    const parent = commands.create({ title: 'p' });
    expect(() => commands.link(parent.id, 'missing-child')).toThrowError(/not found/);
    expect(() => commands.link('missing-parent', parent.id)).toThrowError(/not found/);
  });

  it('log returns the task event list', () => {
    const { commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    commands.comment(t.id, 'note');
    const log = commands.log(t.id);
    expect(log.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['task_created', 'comment_added'])
    );
  });

  it('requestDecompose flags a triage task and logs an event', () => {
    const { commands, store } = makeCommands();
    const t = store.createTask({ title: 'big', status: 'triage' });
    commands.requestDecompose(t.id);
    expect(store.getTask(t.id)?.pendingMode).toBe('decompose');
    expect(store.listEvents(t.id).some((e) => e.kind === 'decompose_requested')).toBe(true);
  });

  it('requestSpecify flags a triage task with specify', () => {
    const { commands, store } = makeCommands();
    const t = store.createTask({ title: 'vague', status: 'triage' });
    commands.requestSpecify(t.id);
    expect(store.getTask(t.id)?.pendingMode).toBe('specify');
    expect(store.listEvents(t.id).some((e) => e.kind === 'specify_requested')).toBe(true);
  });

  it('requestDecompose rejects a non-triage task', () => {
    const { commands, store } = makeCommands();
    const t = store.createTask({ title: 'x', status: 'todo' });
    expect(() => commands.requestDecompose(t.id)).toThrow(/triage/i);
  });

  it('requestDecompose rejects an unknown task', () => {
    const { commands } = makeCommands();
    expect(() => commands.requestDecompose('nope')).toThrow(/not found/i);
  });

  it('dispatch ticks the dispatcher (claims a ready task)', () => {
    const store = new KanbanStore(join(TEST_DIR, `disp-${Math.random().toString(36).slice(2)}.db`));
    const spawned: string[] = [];
    const dispatcher = new KanbanDispatcher(store, {
      now: () => 0,
      isAlive: () => true,
      spawnWorker: (a) => {
        spawned.push(a.task.id);
        return 123;
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
    const commands = new KanbanCommands(store, dispatcher, () => ({
      workspaceKind: 'worktree',
      maxRuntimeSeconds: null
    }));
    const t = commands.create({ title: 'go', status: 'ready', assignee: 'r' });
    commands.dispatch();
    expect(spawned).toContain(t.id);
    store.close();
  });
});
