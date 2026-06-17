import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
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
      autoAssign: false,
      autoIntegrate: false,
      autoReview: false,
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

  it('setManualStatus rejects review for a non-worktree task', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x', status: 'todo', workspaceKind: 'scratch' });
    expect(() => commands.setManualStatus(t.id, 'review')).toThrowError(/worktree/);
    expect(store.getTask(t.id)?.status).toBe('todo');
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
        autoAssign: false,
        autoIntegrate: false,
      autoReview: false,
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
        autoAssign: false,
        autoIntegrate: false,
      autoReview: false,
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

  it('archiving a worktree task via setManualStatus removes its worktree and a merged branch', () => {
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
    // Branch is at main's HEAD (no new commits) → merged → archive deletes it.
    store.setWorkspace(task.id, wt.path, wt.branchName, wt.baseBranch);
    expect(existsSync(wt.path)).toBe(true);

    commands.setManualStatus(task.id, 'archived');

    expect(store.getTask(task.id)?.status).toBe('archived');
    expect(existsSync(wt.path)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `kanban/${task.id}`], {
      encoding: 'utf8'
    });
    expect(branches.trim()).toBe('');
  });

  it('archiving a worktree task keeps an unmerged branch and logs an event', () => {
    const { store, commands } = makeCommands();
    const repo = makeRepo('cmd-rm-keep');
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
    store.setWorkspace(task.id, wt.path, wt.branchName, wt.baseBranch);
    // Commit unmerged work on the branch so archive must preserve it.
    writeFileSync(join(wt.path, 'feature.txt'), 'work');
    execFileSync('git', ['-C', wt.path, 'add', '-A']);
    execFileSync('git', ['-C', wt.path, 'commit', '-q', '-m', 'feature']);

    commands.setManualStatus(task.id, 'archived');

    expect(store.getTask(task.id)?.status).toBe('archived');
    expect(existsSync(wt.path)).toBe(false); // dir freed
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `kanban/${task.id}`], {
      encoding: 'utf8'
    });
    expect(branches.trim()).not.toBe(''); // branch preserved
    const events = store.listEvents(task.id);
    expect(events.some((e) => e.kind === 'unmerged_branch_kept')).toBe(true);
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

describe('KanbanCommands mergeReviewTask conflict', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('mergeReviewTask on conflict requests a resolve run', () => {
    const store = new KanbanStore(
      join(TEST_DIR, `merge-conflict-${Math.random().toString(36).slice(2)}.db`)
    );
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
        autoAssign: false,
        autoIntegrate: false,
      autoReview: false,
        maxDecompose: 1,
        artifactRetentionDays: 0
      }
    });
    // Record requestResolve calls; return false so no real resolve run spawns.
    const calls: string[] = [];
    dispatcher.requestResolve = (taskId: string): boolean => {
      calls.push(taskId);
      return false;
    };
    const commands = new KanbanCommands(store, dispatcher, () => ({
      workspaceKind: 'scratch',
      maxRuntimeSeconds: null
    }));

    // A repo whose main branch already has a tracked file.
    const repo = makeRepo('cmd-merge-conflict');
    writeFileSync(join(repo, 'shared.txt'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'add shared']);

    const task = store.createTask({
      title: 'conflicting task',
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
    store.setWorkspace(task.id, wt.path, wt.branchName, wt.baseBranch);

    // Diverge: the branch and main both edit shared.txt differently → merge conflicts.
    writeFileSync(join(wt.path, 'shared.txt'), 'branch change\n');
    execFileSync('git', ['-C', wt.path, 'add', '-A']);
    execFileSync('git', ['-C', wt.path, 'commit', '-q', '-m', 'branch edit']);
    writeFileSync(join(repo, 'shared.txt'), 'main change\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'main edit']);

    commands.setManualStatus(task.id, 'review');

    const res = commands.mergeReviewTask(task.id);
    expect(res.ok).toBe(false);
    expect(res.conflict).toBe(true);
    expect(calls).toEqual([task.id]);
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
        autoAssign: false,
        autoIntegrate: false,
      autoReview: false,
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

describe('KanbanCommands.enforceDecomposeGrouping', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('groups a decompose parent + its ≥2 worktree children into a new feature', () => {
    const { store, commands } = makeCommands();
    const parent = store.createTask({
      title: 'Build auth',
      status: 'done',
      workspaceKind: 'worktree',
      repoPath: '/repo',
      baseBranch: 'main'
    });
    const c1 = store.createTask({ title: 'a', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    const c2 = store.createTask({ title: 'b', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    store.addLink(parent.id, c1.id);
    store.addLink(parent.id, c2.id);

    commands.enforceDecomposeGrouping(parent.id);

    const features = store.listFeatures({});
    expect(features).toHaveLength(1);
    expect(features[0].name).toBe('Build auth');
    expect(features[0].repoPath).toBe('/repo');
    expect(store.getTask(parent.id)?.featureId).toBe(features[0].id);
    expect(store.getTask(c1.id)?.featureId).toBe(features[0].id);
    expect(store.getTask(c2.id)?.featureId).toBe(features[0].id);
    store.close();
  });

  it('is a no-op when fewer than 2 worktree children exist', () => {
    const { store, commands } = makeCommands();
    const parent = store.createTask({ title: 'p', status: 'done', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    const c1 = store.createTask({ title: 'a', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    const scratch = store.createTask({ title: 's' }); // scratch child does not count
    store.addLink(parent.id, c1.id);
    store.addLink(parent.id, scratch.id);
    commands.enforceDecomposeGrouping(parent.id);
    expect(store.listFeatures({})).toHaveLength(0);
    store.close();
  });

  it('is a no-op when the children are already grouped (orchestrator grouped them)', () => {
    const { store, commands } = makeCommands();
    const f = store.createFeature({ boardId: 'default', name: 'pre', repoPath: '/repo', baseBranch: 'main' });
    const parent = store.createTask({ title: 'p', status: 'done', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    const c1 = store.createTask({ title: 'a', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main', featureId: f.id });
    const c2 = store.createTask({ title: 'b', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main', featureId: f.id });
    store.addLink(parent.id, c1.id);
    store.addLink(parent.id, c2.id);
    commands.enforceDecomposeGrouping(parent.id);
    expect(store.listFeatures({})).toHaveLength(1); // no new feature
    store.close();
  });

  it('is a no-op when the parent is already in a feature', () => {
    const { store, commands } = makeCommands();
    const f = store.createFeature({ boardId: 'default', name: 'pre', repoPath: '/repo', baseBranch: 'main' });
    const parent = store.createTask({ title: 'p', status: 'done', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main', featureId: f.id });
    const c1 = store.createTask({ title: 'a', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    const c2 = store.createTask({ title: 'b', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    store.addLink(parent.id, c1.id);
    store.addLink(parent.id, c2.id);
    commands.enforceDecomposeGrouping(parent.id);
    expect(store.listFeatures({})).toHaveLength(1);
    store.close();
  });
});

describe('project commands', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('addProject validates name, path existence, and duplicates', () => {
    const { commands } = makeCommands();
    const dir = TEST_DIR; // exists
    expect(() => commands.addProject({ boardId: 'default', name: '  ', path: dir })).toThrow(/name/i);
    expect(() =>
      commands.addProject({ boardId: 'default', name: 'x', path: join(TEST_DIR, 'nope') })
    ).toThrow(/does not exist|not a directory/i);
    const file = join(TEST_DIR, 'afile.txt');
    writeFileSync(file, 'x');
    expect(() => commands.addProject({ boardId: 'default', name: 'x', path: file })).toThrow(
      /not a directory/i
    );
    commands.addProject({ boardId: 'default', name: 'fleet', path: dir });
    expect(() => commands.addProject({ boardId: 'default', name: 'fleet', path: dir })).toThrow(
      /already/i
    );
  });

  it('addProject rejects an unknown board', () => {
    expect(() =>
      makeCommands().commands.addProject({ boardId: 'ghost', name: 'x', path: TEST_DIR })
    ).toThrow(/board not found/i);
  });

  it('removeProject / setDefaultProject require an existing project', () => {
    const { commands } = makeCommands();
    expect(() => commands.removeProject('nope')).toThrow(/not found/i);
    expect(() => commands.setDefaultProject('nope')).toThrow(/not found/i);
  });
});

describe('KanbanCommands suggestions', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('accept creates a feature + assigns tasks + marks accepted', () => {
    const { store, commands } = makeCommands();
    const t1 = store.createTask({ title: 'task 1', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    const t2 = store.createTask({ title: 'task 2', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    const s = store.createSuggestion({ boardId: 'default', name: 'My Feature', repoPath: '/repo', taskIds: [t1.id, t2.id] });

    const feature = commands.acceptSuggestion(s.id);

    expect(feature.name).toBe('My Feature');
    expect(feature.repoPath).toBe('/repo');
    expect(feature.baseBranch).toBe('main');
    expect(store.getTask(t1.id)?.featureId).toBe(feature.id);
    expect(store.getTask(t2.id)?.featureId).toBe(feature.id);
    expect(store.getSuggestion(s.id)?.status).toBe('accepted');
  });

  it('accept skips tasks that no longer exist', () => {
    const { store, commands } = makeCommands();
    const t1 = store.createTask({ title: 'existing', workspaceKind: 'scratch' });
    const s = store.createSuggestion({ boardId: 'default', name: 'Partial', repoPath: null, taskIds: [t1.id, 'ghost-id'] });

    const feature = commands.acceptSuggestion(s.id);

    const members = store.listFeatureTasks(feature.id);
    expect(members.map((t) => t.id)).toContain(t1.id);
    expect(members.map((t) => t.id)).not.toContain('ghost-id');
    expect(store.getSuggestion(s.id)?.status).toBe('accepted');
  });

  it('accept throws + dismisses (no feature) when all suggested tasks are gone', () => {
    const { store, commands } = makeCommands();
    const s = store.createSuggestion({ boardId: 'default', name: 'All Gone', repoPath: '/repo', taskIds: ['ghost-1', 'ghost-2'] });

    let code: string | undefined;
    try {
      commands.acceptSuggestion(s.id);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('BAD_REQUEST');
    expect(store.listFeatures({})).toHaveLength(0);
    expect(store.getSuggestion(s.id)?.status).toBe('dismissed');
  });

  it('dismiss marks dismissed without creating a feature', () => {
    const { store, commands } = makeCommands();
    const s = store.createSuggestion({ boardId: 'default', name: 'Ignore Me', repoPath: null, taskIds: [] });

    commands.dismissSuggestion(s.id);

    expect(store.getSuggestion(s.id)?.status).toBe('dismissed');
    expect(store.listFeatures({})).toHaveLength(0);
  });

  it('acceptSuggestion throws NOT_FOUND for an unknown suggestion id', () => {
    const { commands } = makeCommands();
    let code: string | undefined;
    try {
      commands.acceptSuggestion('nope');
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('NOT_FOUND');
  });

  it('dismissSuggestion throws NOT_FOUND for an unknown suggestion id', () => {
    const { commands } = makeCommands();
    let code: string | undefined;
    try {
      commands.dismissSuggestion('nope');
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('NOT_FOUND');
  });
});

describe('KanbanCommands verify commands', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('addProject persists verify_commands and setProjectVerifyCommands updates them', () => {
    const { store, commands } = makeCommands();
    const dir = mkdtempSync(join(tmpdir(), 'verify-proj-'));
    const p = commands.addProject({
      boardId: 'default',
      name: 'app',
      path: dir,
      verifyCommands: [{ label: 'typecheck', command: 'npm run typecheck' }]
    });
    expect(p.verifyCommands).toEqual([{ label: 'typecheck', command: 'npm run typecheck' }]);
    commands.setProjectVerifyCommands(p.id, [{ label: 'tests', command: 'npm test' }]);
    expect(store.getProject(p.id)?.verifyCommands).toEqual([{ label: 'tests', command: 'npm test' }]);
  });
});

describe('approve_spec proposal', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  // Mirrors the real fan-out topology (template-expander + architect run):
  // spec(done) → gate(blocked); implement child linked gate→child and child→qa; qa linked gate→qa.
  function seedPipeline(store: KanbanStore): {
    specId: string;
    gateId: string;
    childId: string;
    qaId: string;
  } {
    const spec = store.createTask({ title: 'spec', status: 'done', pipelineStage: 'spec' });
    const gate = store.createTask({ title: 'gate', status: 'blocked', pipelineStage: 'gate' });
    const child = store.createTask({ title: 'impl', status: 'todo', pipelineStage: 'implement' });
    const qa = store.createTask({ title: 'qa', status: 'todo', pipelineStage: 'qa' });
    store.addLink(spec.id, gate.id);
    store.addLink(gate.id, child.id);
    store.addLink(gate.id, qa.id);
    store.addLink(child.id, qa.id);
    return { specId: spec.id, gateId: gate.id, childId: child.id, qaId: qa.id };
  }

  it('approve marks the gate done so children can promote; before approve they cannot', () => {
    const { store, commands } = makeCommands();
    const { gateId, childId } = seedPipeline(store);

    // Gate is blocked: the implement child is gated and must NOT be promotable.
    expect(store.promotableTodoTasks().map((t) => t.id)).not.toContain(childId);

    // Mark the gate done directly and confirm the gating releases (the child becomes
    // promotable) before the dispatcher tick consumes it.
    store.setStatus(gateId, 'done');
    expect(store.promotableTodoTasks().map((t) => t.id)).toContain(childId);
    store.setStatus(gateId, 'blocked'); // reset for the real executor path below

    // Drive the real executor path via an approve_spec proposal targeting the gate.
    // approveSpec marks the gate done and ticks the dispatcher, which promotes the
    // now-ungated implement child from 'todo' to 'ready'.
    const proposal = commands.proposeAction('default', 'approve_spec', gateId, 'looks good');
    const after = commands.approveProposal(proposal.id);
    expect(after.status).toBe('accepted');

    expect(store.getTask(gateId)?.status).toBe('done');
    expect(store.getTask(childId)?.status).toBe('ready');
    store.close();
  });

  it('dismiss re-arms the spec (ready), archives prior children, clears both guards', () => {
    const { store, commands } = makeCommands();
    const { specId, gateId, childId, qaId } = seedPipeline(store);
    // Seed both guards the prior architect run + dispatcher would have stamped on the spec:
    // the fan-out guard and the one-shot approval guard.
    store.appendEvent(specId, null, 'children_emitted', { runId: 1 });
    store.appendEvent(specId, null, 'spec_approval_raised', { gateId, children: 1 });

    const proposal = commands.proposeAction('default', 'approve_spec', gateId, 'needs work');
    commands.dismissProposal(proposal.id);

    expect(store.getTask(specId)?.status).toBe('ready');
    expect(store.getTask(childId)?.status).toBe('archived');
    // The qa task is a direct child of the gate too, but the implement-only filter
    // must leave it untouched so it can still gate QA after the re-armed fan-out.
    expect(store.getTask(qaId)?.status).toBe('todo');
    // Both guards must be cleared — leaving spec_approval_raised would permanently
    // silence the dispatcher's raiseSpecApprovals so no second proposal could ever fire.
    expect(store.listEvents(specId).some((e) => e.kind === 'children_emitted')).toBe(false);
    expect(store.listEvents(specId).some((e) => e.kind === 'spec_approval_raised')).toBe(false);
    expect(
      store.listComments(specId).some((c) => c.body.includes('Spec dismissed'))
    ).toBe(true);
    store.close();
  });

  it('after dismiss, a re-armed spec that completes again raises a fresh approval proposal', () => {
    const { store, commands } = makeCommands();
    const { specId, gateId, childId, qaId } = seedPipeline(store);
    void qaId;
    store.appendEvent(specId, null, 'children_emitted', { runId: 1 });
    store.appendEvent(specId, null, 'spec_approval_raised', { gateId, children: 1 });

    const first = commands.proposeAction('default', 'approve_spec', gateId, 'needs work');
    commands.dismissProposal(first.id);
    expect(store.getTask(childId)?.status).toBe('archived'); // prior child settled

    // Simulate the re-armed architect run: a fresh implement child off the gate, then the
    // spec completes again. The dispatcher tick must raise a NEW approve_spec proposal
    // (it would not if the spec_approval_raised guard had survived the dismiss).
    const child2 = store.createTask({
      title: 'impl-v2',
      status: 'todo',
      pipelineStage: 'implement'
    });
    store.addLink(gateId, child2.id);
    store.setStatus(specId, 'done');
    commands.dispatch();

    const pending = store.listProposals('default', { status: 'pending' });
    expect(pending.filter((p) => p.kind === 'approve_spec' && p.targetId === gateId)).toHaveLength(
      1
    );
    store.close();
  });
});
