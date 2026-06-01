import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { prepareWorkspace } from '../kanban/workspace';
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
      maxDecompose: 1,
      artifactRetentionDays: 0
    }
  });
  const commands = new KanbanCommands(store, dispatcher, () => ({
    workspaceKind: 'scratch',
    maxRuntimeSeconds: null
  }));
  return { store, commands };
}

function makeRepo(name: string): string {
  const repo = join(TEST_DIR, name);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.t']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
  return repo;
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
    expect(task.workspaceKind).toBe('scratch');
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

  it('rejects a worktree task with no repoPath', () => {
    const { commands } = makeCommands();
    expect(() => commands.create({ title: 'no repo', workspaceKind: 'worktree' })).toThrow(/repo/i);
  });

  it('allows a scratch task with no repoPath', () => {
    const { commands } = makeCommands();
    const task = commands.create({ title: 'scratch ok', workspaceKind: 'scratch' });
    expect(task.workspaceKind).toBe('scratch');
  });

  it('stores repoPath for a worktree task', () => {
    const { commands } = makeCommands();
    const task = commands.create({
      title: 'wt',
      workspaceKind: 'worktree',
      repoPath: '/src/repo'
    });
    expect(task.repoPath).toBe('/src/repo');
    expect(task.workspaceKind).toBe('worktree');
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
        maxDecompose: 1,
        artifactRetentionDays: 0
      },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    const commands = new KanbanCommands(store, dispatcher, () => ({
      workspaceKind: 'scratch',
      maxRuntimeSeconds: null
    }));
    const t = commands.create({ title: 'go', status: 'ready', assignee: 'r' });
    commands.dispatch();
    expect(spawned).toContain(t.id);
    store.close();
  });
});

describe('KanbanCommands replyAndResume', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  // A dispatcher that never claims, so the resume *target* state is observable
  // (the real dispatcher's tick would immediately move a resumed task to running).
  function makeNoClaim(): { store: KanbanStore; commands: KanbanCommands } {
    const store = new KanbanStore(join(TEST_DIR, `rr-${Math.random().toString(36).slice(2)}.db`));
    const dispatcher = new KanbanDispatcher(store, {
      now: () => 0,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 0,
        claimTtlMs: 1000,
        autoDecompose: false,
        maxDecompose: 0,
        artifactRetentionDays: 0
      }
    });
    const commands = new KanbanCommands(store, dispatcher, () => ({
      workspaceKind: 'scratch',
      maxRuntimeSeconds: null
    }));
    return { store, commands };
  }

  it('rejects a task that is not blocked', () => {
    const { commands } = makeNoClaim();
    const t = commands.create({ title: 'x', status: 'todo' });
    expect(() => commands.replyAndResume(t.id, 'hi')).toThrowError(/blocked/i);
  });

  it('posts the reply and returns a blocked worker task to ready', () => {
    const { store, commands } = makeNoClaim();
    const t = commands.create({ title: 'x', status: 'todo', assignee: 'worker' });
    store.startRun(t.id, 'worker', null, 'work'); // prior work run
    commands.block(t.id, 'which db?');
    commands.replyAndResume(t.id, 'use postgres');
    expect(store.getTask(t.id)?.status).toBe('ready');
    expect(store.listComments(t.id).map((c) => c.body)).toContain('use postgres');
    expect(store.listEvents(t.id).map((e) => e.kind)).toContain('comment_added');
  });

  it('re-arms a blocked orchestrator task back to triage with its pending mode', () => {
    const { store, commands } = makeNoClaim();
    const t = store.createTask({ title: 'big', status: 'triage' });
    store.startRun(t.id, 'orchestrator', null, 'decompose'); // prior orchestrator run
    commands.block(t.id, 'need scope');
    commands.replyAndResume(t.id, 'split by service');
    const got = store.getTask(t.id);
    expect(got?.status).toBe('triage');
    expect(got?.pendingMode).toBe('decompose');
    expect(store.listEvents(t.id).some((e) => e.kind === 'decompose_requested')).toBe(true);
  });

  it('resumes with an empty body without posting a comment', () => {
    const { store, commands } = makeNoClaim();
    const t = commands.create({ title: 'x', status: 'todo', assignee: 'worker' });
    store.startRun(t.id, 'worker', null, 'work');
    commands.block(t.id, 'q');
    commands.replyAndResume(t.id, '   ');
    expect(store.getTask(t.id)?.status).toBe('ready');
    expect(store.listComments(t.id)).toHaveLength(0);
  });

  it('clears failure counters so a gave-up task resumes with a clean slate', () => {
    const { store, commands } = makeNoClaim();
    const t = commands.create({ title: 'x', status: 'todo', assignee: 'worker' });
    store.startRun(t.id, 'worker', null, 'work');
    store.recordFailure(t.id, 'boom');
    store.giveUp(t.id, 'too many');
    expect(store.getTask(t.id)!.consecutiveFailures).toBeGreaterThan(0);
    commands.replyAndResume(t.id, 'try again');
    const got = store.getTask(t.id);
    expect(got?.status).toBe('ready');
    expect(got?.consecutiveFailures).toBe(0);
    expect(got?.lastFailureError).toBeNull();
  });
});

describe('KanbanCommands archive worktree teardown', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('archiving a worktree task via setManualStatus removes its worktree and branch', () => {
    const { store, commands } = makeCommands();
    const repo = makeRepo('cmd-rm1');
    const task = store.createTask({
      title: 'wt task',
      status: 'todo',
      workspaceKind: 'worktree',
      repoPath: repo
    });
    const wt = prepareWorkspace({
      kind: 'worktree',
      taskId: task.id,
      workspacesRoot: TEST_DIR,
      worktreesRoot: join(TEST_DIR, 'worktrees'),
      repoPath: repo
    });
    store.setWorkspace(task.id, wt.path, wt.branchName);
    expect(existsSync(wt.path)).toBe(true);

    commands.setManualStatus(task.id, 'archived');

    expect(store.getTask(task.id)?.status).toBe('archived');
    expect(existsSync(wt.path)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `kanban/${task.id}`], {
      encoding: 'utf8'
    });
    expect(branches.trim()).toBe('');
  });

  it('archiving a scratch task does not throw and just archives', () => {
    const { store, commands } = makeCommands();
    const task = commands.create({ title: 'scratch task', status: 'todo' });
    expect(() => commands.setManualStatus(task.id, 'archived')).not.toThrow();
    expect(store.getTask(task.id)?.status).toBe('archived');
  });

  it('archives a worktree task even when its repo and worktree are gone', () => {
    const { store, commands } = makeCommands();
    const task = store.createTask({
      title: 'wt',
      status: 'todo',
      workspaceKind: 'worktree',
      repoPath: join(TEST_DIR, 'missing-repo')
    });
    store.setWorkspace(task.id, join(TEST_DIR, 'missing-wt'), `kanban/${task.id}`);
    expect(() => commands.setManualStatus(task.id, 'archived')).not.toThrow();
    expect(store.getTask(task.id)?.status).toBe('archived');
  });
});

describe('KanbanCommands attachments', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function srcFile(name: string): string {
    const p = join(TEST_DIR, name);
    writeFileSync(p, 'x');
    return p;
  }

  it('addAttachment attaches a file, logs an event, and show() returns it', () => {
    const { store, commands } = makeCommands();
    const task = commands.create({ title: 't' });
    const att = commands.addAttachment(task.id, srcFile('a.txt'));

    const detail = commands.show(task.id);
    expect(detail?.attachments.map((a) => a.id)).toContain(att.id);
    expect(store.listEvents(task.id).some((e) => e.kind === 'attachment_added')).toBe(true);
  });

  it('removeAttachment deletes the row and logs an event', () => {
    const { store, commands } = makeCommands();
    const task = commands.create({ title: 't' });
    const att = commands.addAttachment(task.id, srcFile('b.txt'));
    commands.removeAttachment(att.id);

    expect(commands.show(task.id)?.attachments).toHaveLength(0);
    expect(store.listEvents(task.id).some((e) => e.kind === 'attachment_removed')).toBe(true);
  });

  it('addAttachment throws for a missing task', () => {
    const { commands } = makeCommands();
    expect(() => commands.addAttachment('nope', srcFile('c.txt'))).toThrow();
  });
});

describe('KanbanCommands scheduling', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('setSchedule rejects an invalid cron with BAD_REQUEST', () => {
    const { commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    let code: string | undefined;
    try {
      commands.setSchedule(t.id, { kind: 'cron', expr: 'nope' });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('BAD_REQUEST');
  });

  it('setSchedule rejects a non-positive interval with BAD_REQUEST', () => {
    const { commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    let code: string | undefined;
    try {
      commands.setSchedule(t.id, { kind: 'interval', everyMs: 0 });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('BAD_REQUEST');
  });

  it('setSchedule with a valid interval round-trips and logs an event', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x', assignee: 'r' });
    commands.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    expect(store.getTask(t.id)!.status).toBe('scheduled');
    expect(store.listEvents(t.id).some((e) => e.kind === 'schedule_set')).toBe(true);
  });

  it('pauseSchedule rejects a one-shot schedule', () => {
    const { commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    commands.setSchedule(t.id, { kind: 'once', at: 99_000 });
    let code: string | undefined;
    try {
      commands.pauseSchedule(t.id);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('BAD_REQUEST');
  });

  it('previewSchedule returns next fire times for a valid schedule', () => {
    const { commands } = makeCommands();
    const res = commands.previewSchedule({ kind: 'interval', everyMs: 1000 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.next.length).toBe(3);
  });

  it('previewSchedule returns an error for an invalid cron', () => {
    const { commands } = makeCommands();
    const res = commands.previewSchedule({ kind: 'cron', expr: 'nope' });
    expect(res.ok).toBe(false);
  });

  it('resumeSchedule on a paused recurring schedule clears the flag and logs an event', () => {
    const { commands, store } = makeCommands();
    const t = commands.create({ title: 'x', assignee: 'r' });
    commands.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    commands.pauseSchedule(t.id);
    commands.resumeSchedule(t.id);
    expect(store.getTask(t.id)!.schedulePaused).toBe(false);
    expect(store.listEvents(t.id).some((e) => e.kind === 'schedule_resumed')).toBe(true);
  });

  it('clearSchedule returns a scheduled task to todo and logs schedule_cleared', () => {
    const { commands, store } = makeCommands();
    const t = commands.create({ title: 'x', assignee: 'r' });
    commands.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    commands.clearSchedule(t.id);
    expect(store.getTask(t.id)!.status).toBe('todo');
    expect(store.listEvents(t.id).some((e) => e.kind === 'schedule_cleared')).toBe(true);
  });

  it('moving a scheduled task out of the lane drops its schedule', () => {
    const { commands, store } = makeCommands();
    const t = commands.create({ title: 'x', assignee: 'r' });
    commands.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    commands.setManualStatus(t.id, 'ready');
    const got = store.getTask(t.id)!;
    expect(got.status).toBe('ready');
    expect(got.scheduleKind).toBeNull();
    expect(got.nextRunAt).toBeNull();
  });
});

describe('KanbanCommands.createSwarm', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  function setup(profiles: Array<{ name: string; role: string }> = []) {
    const store = new KanbanStore(join(TEST_DIR, `cmd-swarm-${Math.random()}.db`));
    const dispatcher = new KanbanDispatcher(store, {
      now: () => Date.now(),
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      }
    });
    const events: string[] = [];
    store['onEvent'] = (e) => events.push(e.kind); // capture emitted kinds
    const commands = new KanbanCommands(
      store,
      dispatcher,
      () => ({ workspaceKind: 'scratch', maxRuntimeSeconds: null }),
      () => profiles
    );
    return { store, commands, events };
  }

  const base = {
    goal: 'Plan failover',
    workers: [{ profile: 'researcher', title: 'Research' }],
    verifierAssignee: 'reviewer',
    synthesizerAssignee: 'writer'
  };

  it('creates the graph and emits swarm_created + per-card task_created', () => {
    const { commands, events, store } = setup([
      { name: 'researcher', role: 'worker' },
      { name: 'reviewer', role: 'worker' },
      { name: 'writer', role: 'worker' }
    ]);
    const created = commands.createSwarm(base);
    expect(store.getTask(created.rootId)!.status).toBe('done');
    expect(events).toContain('swarm_created');
    expect(events.filter((k) => k === 'task_created')).toHaveLength(3); // 1 worker + verifier + synth
  });

  it('rejects an empty workers list', () => {
    const { commands } = setup();
    expect(() => commands.createSwarm({ ...base, workers: [] })).toThrow();
  });

  it('rejects an unknown worker profile when profiles are configured', () => {
    const { commands } = setup([
      { name: 'reviewer', role: 'worker' },
      { name: 'writer', role: 'worker' }
    ]);
    expect(() => commands.createSwarm(base)).toThrow(/unknown worker profile/);
  });

  it('rejects a worktree swarm with no repoPath', () => {
    const { commands } = setup([
      { name: 'researcher', role: 'worker' },
      { name: 'reviewer', role: 'worker' },
      { name: 'writer', role: 'worker' }
    ]);
    expect(() => commands.createSwarm({ ...base, workspaceKind: 'worktree' })).toThrow(/repo/);
  });

  it('rejects more than the worker cap', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ profile: 'researcher', title: `t${i}` }));
    const { commands } = setup([{ name: 'researcher', role: 'worker' }]);
    expect(() => commands.createSwarm({ ...base, workers: many })).toThrow(/at most/);
  });

  it('seedArtifactId attaches a kept artifact copy to the root task only', () => {
    const { store, commands } = setup([
      { name: 'researcher', role: 'worker' },
      { name: 'reviewer', role: 'worker' },
      { name: 'writer', role: 'worker' }
    ]);
    const src = store.createTask({ title: 'producer' });
    const ws = join(TEST_DIR, `seed-ws-${Math.random().toString(36).slice(2)}`);
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'out.md'), 'payload');
    const art = store.addArtifact({
      taskId: src.id,
      runId: null,
      boardId: src.boardId,
      workspaceRoot: ws,
      relPath: 'out.md'
    });

    const created = commands.createSwarm({ ...base, seedArtifactId: art.id });
    const rootAtts = store.listAttachments(created.rootId);
    expect(rootAtts).toHaveLength(1);
    expect(existsSync(rootAtts[0].storedPath)).toBe(true);
    expect(store.getTask(created.rootId)!.body).toMatch(/Seeded from artifact: out\.md/);
    // workers/verifier/synth do not receive the copy
    expect(store.listAttachments(created.workerIds[0])).toHaveLength(0);
    expect(store.listAttachments(created.verifierId)).toHaveLength(0);
  });

  it('seedArtifactId refuses a discarded artifact', () => {
    const { store, commands } = setup([
      { name: 'researcher', role: 'worker' },
      { name: 'reviewer', role: 'worker' },
      { name: 'writer', role: 'worker' }
    ]);
    const src = store.createTask({ title: 'producer' });
    const ws = join(TEST_DIR, `seed-ws2-${Math.random().toString(36).slice(2)}`);
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'out.md'), 'payload');
    const art = store.addArtifact({
      taskId: src.id,
      runId: null,
      boardId: src.boardId,
      workspaceRoot: ws,
      relPath: 'out.md'
    });
    store.discardArtifact(art.id);
    expect(() => commands.createSwarm({ ...base, seedArtifactId: art.id })).toThrow(/kept/);
    // a rejected seed must not leave a half-built swarm: only the producer task exists
    expect(store.listTasks()).toHaveLength(1);
  });
});

describe('KanbanCommands boards', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('createBoard derives a slug and listBoards returns it', () => {
    const { commands } = makeCommands();
    const b = commands.createBoard('Research');
    expect(b.slug).toBe('research');
    expect(commands.listBoards().map((x) => x.slug)).toContain('research');
  });

  it('createBoard rejects an empty / junk name', () => {
    const { commands } = makeCommands();
    expect(() => commands.createBoard('   ')).toThrow();
    expect(() => commands.createBoard('!!!')).toThrow();
  });

  it('renameBoard rejects an empty / junk name', () => {
    const { commands } = makeCommands();
    commands.createBoard('Research');
    expect(() => commands.renameBoard('research', '  ')).toThrow();
    expect(() => commands.renameBoard('research', '!!!')).toThrow();
  });

  it('deleteBoard refuses the default board', () => {
    const { commands } = makeCommands();
    expect(() => commands.deleteBoard('default')).toThrow();
  });

  it('deleteBoard refuses a board with a running task', () => {
    const { store, commands } = makeCommands();
    commands.createBoard('Research');
    const t = store.createTask({ title: 'busy', boardId: 'research' });
    store.setStatus(t.id, 'running');
    expect(() => commands.deleteBoard('research')).toThrow();
    expect(commands.listBoards().map((b) => b.slug)).toContain('research');
  });

  it('deleteBoard removes an idle board', () => {
    const { store, commands } = makeCommands();
    commands.createBoard('Research');
    store.createTask({ title: 'idle', boardId: 'research' });
    commands.deleteBoard('research');
    expect(commands.listBoards().map((b) => b.slug)).not.toContain('research');
  });
});

describe('KanbanCommands scratch archive safety net', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // workspacesRoot is derived as join(dirname(dbPath), 'workspaces'); dbPath lives in TEST_DIR.
  function scratchWorkspace(store: KanbanStore, taskId: string): string {
    const ws = join(TEST_DIR, 'workspaces', taskId);
    mkdirSync(ws, { recursive: true });
    store.setWorkspace(taskId, ws, null);
    return ws;
  }

  it('preserves the workspace and warns when unregistered files remain on archive', () => {
    const { store, commands } = makeCommands();
    const task = commands.create({ title: 't' });
    const ws = scratchWorkspace(store, task.id);
    writeFileSync(join(ws, 'out.md'), 'hi');
    commands.archive(task.id);
    expect(existsSync(ws)).toBe(true); // never warn-then-delete
    expect(store.listEvents(task.id).map((e) => e.kind)).toContain('artifacts_unregistered');
  });

  it('deletes the scratch workspace on archive when every file is registered', () => {
    const { store, commands } = makeCommands();
    const task = commands.create({ title: 't' });
    const ws = scratchWorkspace(store, task.id);
    writeFileSync(join(ws, 'out.md'), 'hi');
    store.addArtifact({
      taskId: task.id,
      runId: null,
      boardId: task.boardId,
      workspaceRoot: ws,
      relPath: 'out.md'
    });
    commands.archive(task.id);
    expect(existsSync(ws)).toBe(false);
  });

  it('discardTaskWorkspaceLeftovers guards non-archived tasks and then deletes', () => {
    const { store, commands } = makeCommands();
    const task = commands.create({ title: 't' });
    const ws = scratchWorkspace(store, task.id);
    writeFileSync(join(ws, 'out.md'), 'hi');
    expect(() => commands.discardTaskWorkspaceLeftovers(task.id)).toThrow(); // not archived
    commands.archive(task.id);
    expect(existsSync(ws)).toBe(true); // preserved by the warning path
    commands.discardTaskWorkspaceLeftovers(task.id);
    expect(existsSync(ws)).toBe(false);
    expect(store.listEvents(task.id).map((e) => e.kind)).toContain(
      'artifacts_unregistered_discarded'
    );
  });

  it('treats a top-level dir as a leftover until all descendants are registered', () => {
    const { store, commands } = makeCommands();
    const task = commands.create({ title: 't' });
    const ws = scratchWorkspace(store, task.id);
    mkdirSync(join(ws, 'reports'), { recursive: true });
    writeFileSync(join(ws, 'reports', 'a.md'), 'a');
    writeFileSync(join(ws, 'reports', 'b.md'), 'b');
    store.addArtifact({
      taskId: task.id,
      runId: null,
      boardId: task.boardId,
      workspaceRoot: ws,
      relPath: 'reports/a.md'
    });
    expect(store.scratchLeftovers(task.id)).toContain('reports'); // b.md still unregistered
    store.addArtifact({
      taskId: task.id,
      runId: null,
      boardId: task.boardId,
      workspaceRoot: ws,
      relPath: 'reports/b.md'
    });
    expect(store.scratchLeftovers(task.id)).not.toContain('reports');
  });
});
