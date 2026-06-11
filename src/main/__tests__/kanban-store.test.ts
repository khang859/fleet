import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { KanbanStore } from '../kanban/kanban-store';
import { SCHEMA_SQL } from '../kanban/schema';
import type { TaskEvent } from '../../shared/kanban-types';

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
    expect(store.schemaVersion()).toBe(10);
  });

  it('fresh db is created at v10 with the new columns', () => {
    // Fresh store is already v10; assert the new columns exist and are nullable/defaulted.
    const t = store.createTask({ title: 'x' });
    expect(store.getTask(t.id)?.pendingMode).toBeNull();
    const run = store.startRun(t.id, 'p', null);
    expect(run.mode).toBe('work');
    expect(store.schemaVersion()).toBe(10);
  });

  it('fresh db is created at v10 and persists repoPath', () => {
    const t = store.createTask({ title: 'wt', workspaceKind: 'worktree', repoPath: '/src/repo' });
    expect(store.getTask(t.id)?.repoPath).toBe('/src/repo');
    expect(store.getTask(t.id)?.workspaceKind).toBe('worktree');
    expect(store.schemaVersion()).toBe(10);
  });

  it('repoPath defaults to null when omitted', () => {
    const t = store.createTask({ title: 'plain' });
    expect(store.getTask(t.id)?.repoPath).toBeNull();
  });

  it('upgrades a v2 db to v3 (adds repo_path)', () => {
    const v2Path = join(TEST_DIR, 'v2.db');
    const raw = new Database(v2Path);
    raw.exec(SCHEMA_SQL);
    raw.exec('ALTER TABLE tasks DROP COLUMN repo_path');
    raw.pragma('user_version = 2');
    raw.close();

    const s = new KanbanStore(v2Path);
    const t = s.createTask({ title: 'x', workspaceKind: 'worktree', repoPath: '/r' });
    expect(s.getTask(t.id)?.repoPath).toBe('/r');
    expect(s.schemaVersion()).toBe(10);
    s.close();
  });

  it('upgrades a genuine pre-v5 db (tasks without board_id) to v5', () => {
    const preV5Path = join(TEST_DIR, 'pre-v5.db');
    // Build a real pre-v5 tasks table WITHOUT board_id / boards / idx_tasks_board.
    // Must NOT use SCHEMA_SQL — it already includes board_id, which hides this bug.
    const raw = new Database(preV5Path);
    raw.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT,
        body TEXT, priority INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT,
        skills TEXT NOT NULL DEFAULT '[]',
        pending_mode TEXT, repo_path TEXT, workspace_kind TEXT, workspace_path TEXT,
        branch_name TEXT, worker_pid INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    raw.exec(
      "INSERT INTO tasks (id,title,status,created_at,updated_at) VALUES ('abc','old task','todo',1,1)"
    );
    raw.pragma('user_version = 4');
    raw.close();

    const s = new KanbanStore(preV5Path);
    expect(s.schemaVersion()).toBe(10);
    expect(s.getTask('abc')?.boardId).toBe('default');
    expect(s.listBoards().map((b) => b.slug)).toEqual(['default']);
    s.close();
  });

  it('upgrades a v9 db to v10 (adds docs column and projects table)', () => {
    const v9Path = join(TEST_DIR, 'v9.db');
    // Simulate a v9 DB: full current schema minus the v10 additions.
    const raw = new Database(v9Path);
    raw.exec(SCHEMA_SQL);
    raw.exec('ALTER TABLE tasks DROP COLUMN docs');
    raw.exec('DROP TABLE projects');
    raw.exec(
      "INSERT INTO tasks (id,title,status,created_at,updated_at) VALUES ('pre10','old task','todo',1,1)"
    );
    raw.pragma('user_version = 9');
    raw.close();

    // Opening the store must run the ALTER-based upgrade path (+ idempotent SCHEMA_SQL).
    const s = new KanbanStore(v9Path);
    expect(s.schemaVersion()).toBe(10);
    expect(s.getTask('pre10')?.docs).toEqual([]); // pre-migration row gets the default
    const t = s.createTask({ title: 'x', docs: ['guide.md'] });
    expect(s.getTask(t.id)?.docs).toEqual(['guide.md']);
    expect(s.listProjects('default')).toEqual([]);
    s.close();
  });

  it('upgrades a v1 db to v2 (adds missing columns)', () => {
    const v1Path = join(TEST_DIR, 'v1.db');
    // Simulate a v1 DB: full current schema minus the two v2 columns.
    const raw = new Database(v1Path);
    raw.exec(SCHEMA_SQL);
    raw.exec('ALTER TABLE tasks DROP COLUMN pending_mode');
    raw.exec('ALTER TABLE task_runs DROP COLUMN mode');
    raw.pragma('user_version = 1');
    raw.close();

    // Opening the store must run the ALTER-based upgrade path.
    const s = new KanbanStore(v1Path);
    const t = s.createTask({ title: 'x' });
    expect(s.getTask(t.id)?.pendingMode).toBeNull();
    const run = s.startRun(t.id, 'p', null);
    expect(run.mode).toBe('work');
    expect(s.schemaVersion()).toBe(10);
    s.close();
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

  it('starts a run, sets it as current, and finishes it', () => {
    const t = store.createTask({ title: 'x', status: 'ready' });
    const run = store.startRun(t.id, 'researcher', 4321);
    expect(run.status).toBe('running');
    expect(store.getTask(t.id)?.currentRunId).toBe(run.id);
    store.finishRun(run.id, 'completed', { summary: 'did it', metadata: { files: 2 } });
    const runs = store.listRuns(t.id);
    expect(runs[0].outcome).toBe('completed');
    expect(runs[0].summary).toBe('did it');
    expect(runs[0].metadata).toEqual({ files: 2 });
  });

  it('appends and lists events with json payload', () => {
    const t = store.createTask({ title: 'x' });
    store.appendEvent(t.id, null, 'created', { by: 'human' });
    const events = store.listEvents(t.id);
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe('created');
    expect(events[0].payload).toEqual({ by: 'human' });
  });

  it('adds and lists comments in order', () => {
    const t = store.createTask({ title: 'x' });
    store.addComment(t.id, 'researcher', 'first');
    store.addComment(t.id, 'human', 'second');
    const comments = store.listComments(t.id);
    expect(comments.map((c) => c.body)).toEqual(['first', 'second']);
  });

  it('completeTask sets done, stores result, clears claim, resets failures', () => {
    const t = store.createTask({ title: 'x', status: 'ready' });
    store.claimTask(t.id, 'L', 1000);
    const run = store.startRun(t.id, null, 1);
    expect(store.getTask(t.id)?.currentRunId).toBe(run.id);
    store.completeTask(t.id, 'shipped');
    const f = store.getTask(t.id);
    expect(f?.status).toBe('done');
    expect(f?.result).toBe('shipped');
    expect(f?.claimLock).toBeNull();
    expect(f?.consecutiveFailures).toBe(0);
    expect(f?.currentRunId).toBeNull();
  });

  it('blockTask sets blocked and stores reason as result', () => {
    const t = store.createTask({ title: 'x', status: 'ready' });
    store.claimTask(t.id, 'L', 1000);
    const run = store.startRun(t.id, null, 1);
    expect(store.getTask(t.id)?.currentRunId).toBe(run.id);
    store.blockTask(t.id, 'needs key');
    const f = store.getTask(t.id);
    expect(f?.status).toBe('blocked');
    expect(f?.result).toBe('needs key');
    expect(f?.currentRunId).toBeNull();
  });

  it('finishRun is idempotent — does not overwrite an already-finished run', () => {
    const t = store.createTask({ title: 'x', status: 'ready' });
    const run = store.startRun(t.id, 'r', 1);
    store.finishRun(run.id, 'completed', { summary: 'done' });
    // a second finish (e.g. a late reclaim) must NOT clobber the recorded outcome
    store.finishRun(run.id, 'reclaimed', { error: 'late' });
    const runs = store.listRuns(t.id);
    expect(runs[0].outcome).toBe('completed');
    expect(runs[0].summary).toBe('done');
  });

  it('recordFailure increments counter and stores error', () => {
    const t = store.createTask({ title: 'x', status: 'running' });
    store.recordFailure(t.id, 'boom');
    expect(store.getTask(t.id)?.consecutiveFailures).toBe(1);
    store.recordFailure(t.id, 'boom2');
    expect(store.getTask(t.id)?.consecutiveFailures).toBe(2);
    expect(store.getTask(t.id)?.lastFailureError).toBe('boom2');
  });

  it('runningTasks returns only running tasks with claim info', () => {
    const a = store.createTask({ title: 'a', status: 'ready' });
    store.createTask({ title: 'b', status: 'todo' });
    store.claimTask(a.id, 'L', 1000);
    const running = store.runningTasks();
    expect(running.map((t) => t.id)).toEqual([a.id]);
  });

  it('updateTask updates only provided fields and bumps updatedAt', () => {
    const t = store.createTask({ title: 'orig', body: 'b', priority: 1, assignee: 'alice' });
    const before = store.getTask(t.id)!;
    store.updateTask(t.id, { title: 'changed', assignee: null });
    const after = store.getTask(t.id)!;
    expect(after.title).toBe('changed');
    expect(after.assignee).toBeNull();
    expect(after.body).toBe('b'); // untouched
    expect(after.priority).toBe(1); // untouched
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it('listBoard returns cards with comment and child-progress counts', () => {
    const parent = store.createTask({ title: 'parent' });
    const childA = store.createTask({ title: 'a' });
    const childB = store.createTask({ title: 'b' });
    store.addLink(parent.id, childA.id);
    store.addLink(parent.id, childB.id);
    store.setStatus(childA.id, 'done');
    store.addComment(parent.id, 'human', 'hi');
    store.addComment(parent.id, 'human', 'again');

    const cards = store.listBoard();
    const p = cards.find((c) => c.id === parent.id)!;
    expect(p.commentCount).toBe(2);
    expect(p.childTotal).toBe(2);
    expect(p.childDone).toBe(1);
    const a = cards.find((c) => c.id === childA.id)!;
    expect(a.childTotal).toBe(0);
    expect(a.commentCount).toBe(0);
  });

  it('flags and reads pending_mode', () => {
    const t = store.createTask({ title: 'x', status: 'triage' });
    store.setPendingMode(t.id, 'decompose');
    expect(store.getTask(t.id)?.pendingMode).toBe('decompose');
    expect(store.pendingDecomposeTasks().map((x) => x.id)).toEqual([t.id]);
    store.setPendingMode(t.id, null);
    expect(store.getTask(t.id)?.pendingMode).toBeNull();
  });

  it('claimForDecompose atomically moves triage→running and clears pending_mode', () => {
    const t = store.createTask({ title: 'x', status: 'triage' });
    store.setPendingMode(t.id, 'decompose');
    expect(store.claimForDecompose(t.id, 'L', 1000)).toBe(true);
    expect(store.getTask(t.id)?.status).toBe('running');
    expect(store.getTask(t.id)?.pendingMode).toBeNull();
    // a second claim loses (already running / no pending_mode)
    expect(store.claimForDecompose(t.id, 'L2', 1000)).toBe(false);
  });

  it('unassignedReadyTasks returns only ready tasks with no assignee', () => {
    const a = store.createTask({ title: 'unassigned', status: 'ready' });
    store.createTask({ title: 'assigned', status: 'ready', assignee: 'w' });
    store.createTask({ title: 'todo', status: 'todo' });
    const got = store.unassignedReadyTasks().map((t) => t.id);
    expect(got).toEqual([a.id]);
  });

  it('claimForAssign atomically moves ready+unassigned to running', () => {
    const t = store.createTask({ title: 'x', status: 'ready' });
    expect(store.claimForAssign(t.id, 'L', 1000)).toBe(true);
    expect(store.getTask(t.id)?.status).toBe('running');
    // a second claim loses (no longer ready+unassigned)
    expect(store.claimForAssign(t.id, 'L2', 1000)).toBe(false);
  });

  it('claimForAssign re-claims an unassigned ready task whose claim has expired', () => {
    let clock = 1000;
    const s = new KanbanStore(join(TEST_DIR, 'assign-claim.db'), { now: () => clock });
    const t = s.createTask({ title: 'x', status: 'ready' });
    expect(s.claimForAssign(t.id, 'lock-A', 100)).toBe(true); // expires at 1100
    // Put the row back to ready+unassigned but KEEP the live lease, so the ONLY thing
    // blocking a second claim is the unexpired lock.
    s.setStatus(t.id, 'ready');
    expect(s.claimForAssign(t.id, 'lock-B', 100)).toBe(false); // still leased
    clock = 1200; // past expiry
    expect(s.claimForAssign(t.id, 'lock-B', 100)).toBe(true); // lease expired → re-claimable
    s.close();
  });

  it('startRun records the run mode', () => {
    const t = store.createTask({ title: 'x', status: 'triage' });
    const run = store.startRun(t.id, 'orchestrator', null, 'decompose');
    expect(run.mode).toBe('decompose');
    expect(store.runMode(run.id)).toBe('decompose');
  });

  it('orchestratorRunningCount counts only non-work running runs', () => {
    const a = store.createTask({ title: 'a', status: 'triage' });
    store.setPendingMode(a.id, 'decompose');
    store.claimForDecompose(a.id, 'L', 1000);
    store.startRun(a.id, 'orchestrator', null, 'decompose');
    const b = store.createTask({ title: 'b', status: 'ready', assignee: 'r' });
    store.claimTask(b.id, 'L2', 1000);
    store.startRun(b.id, 'r', null, 'work');
    expect(store.orchestratorRunningCount()).toBe(1);
  });

  it('armTriageForDecompose flags up to the limit and returns the count', () => {
    store.createTask({ title: 'a', status: 'triage' });
    store.createTask({ title: 'b', status: 'triage' });
    store.createTask({ title: 'c', status: 'todo' }); // not triage — ignored
    expect(store.armTriageForDecompose(1)).toBe(1);
    expect(store.pendingDecomposeTasks().length).toBe(1);
    expect(store.armTriageForDecompose(5)).toBe(1); // one triage remains unflagged
  });

  it('setStatusCleared resets claim fields', () => {
    const t = store.createTask({ title: 'x', status: 'triage' });
    store.claimForDecompose(t.id, 'L', 1000);
    store.setStatusCleared(t.id, 'triage');
    const got = store.getTask(t.id);
    expect(got?.status).toBe('triage');
    expect(got?.claimLock).toBeNull();
    expect(got?.claimExpires).toBeNull();
    expect(got?.currentRunId).toBeNull();
    expect(got?.lastHeartbeatAt).toBeNull();
  });

  it('setWorkspace persists workspacePath and branchName', () => {
    const t = store.createTask({ title: 'wt', workspaceKind: 'worktree', repoPath: '/r' });
    store.setWorkspace(t.id, '/wt/path', 'kanban/abc');
    const got = store.getTask(t.id);
    expect(got?.workspacePath).toBe('/wt/path');
    expect(got?.branchName).toBe('kanban/abc');
  });

  it('onEvent sink fires for every appended event', () => {
    const seen: TaskEvent[] = [];
    const s = new KanbanStore(join(TEST_DIR, 'sink.db'), {
      now: () => 1000,
      onEvent: (e) => seen.push(e)
    });
    const t = s.createTask({ title: 'x' });
    s.appendEvent(t.id, null, 'status_changed', { to: 'ready' });
    s.close();
    const ev = seen.find((e) => e.kind === 'status_changed')!;
    expect(ev).toMatchObject({
      kind: 'status_changed',
      taskId: t.id,
      runId: null,
      payload: { to: 'ready' },
      createdAt: 1000
    });
  });
});

describe('KanbanStore boards', () => {
  let store: KanbanStore;
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(DB_PATH);
  });
  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('seeds the default board and new tasks land on it', () => {
    expect(store.listBoards().map((b) => b.slug)).toEqual(['default']);
    const t = store.createTask({ title: 'x' });
    expect(t.boardId).toBe('default');
  });

  it('creates boards with unique slugs derived from the name', () => {
    const a = store.createBoard('Research');
    expect(a.slug).toBe('research');
    const b = store.createBoard('Research');
    expect(b.slug).toBe('research-2');
    expect(store.listBoards().map((b2) => b2.slug)).toEqual(['default', 'research', 'research-2']);
  });

  it('renames a board (slug stays fixed)', () => {
    const a = store.createBoard('Research');
    store.renameBoard(a.slug, 'Renamed');
    expect(store.listBoards().find((b) => b.slug === 'research')?.name).toBe('Renamed');
  });

  it('createTask honors boardId and listBoard filters by board', () => {
    store.createBoard('Research');
    store.createTask({ title: 'on default' });
    store.createTask({ title: 'on research', boardId: 'research' });
    expect(store.listBoard('default').map((c) => c.title)).toEqual(['on default']);
    expect(store.listBoard('research').map((c) => c.title)).toEqual(['on research']);
    expect(store.listBoard().length).toBe(2);
  });

  it('deleteBoard removes the board, its tasks, and their child rows', () => {
    store.createBoard('Research');
    const t = store.createTask({ title: 'doomed', boardId: 'research' });
    store.addComment(t.id, 'human', 'a comment');
    store.appendEvent(t.id, null, 'note', {});
    store.deleteBoard('research');
    expect(store.listBoards().map((b) => b.slug)).toEqual(['default']);
    expect(store.getTask(t.id)).toBeNull();
    expect(store.listComments(t.id)).toHaveLength(0);
    expect(store.listEvents(t.id)).toHaveLength(0);
  });

  it('deleteBoard leaves other boards untouched', () => {
    store.createBoard('Research');
    const keep = store.createTask({ title: 'keep' }); // default board
    store.createTask({ title: 'drop', boardId: 'research' });
    store.deleteBoard('research');
    expect(store.getTask(keep.id)?.id).toBe(keep.id);
    expect(store.listBoard('default')).toHaveLength(1);
  });
});

describe('KanbanStore schema v6 migration', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('migrates a v5 database to v6 with schedule columns and intact rows', () => {
    const dbPath = join(TEST_DIR, `mig-v6-${Math.random()}.db`);
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      assignee TEXT, status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 0,
      tenant TEXT, workspace_kind TEXT NOT NULL DEFAULT 'scratch', workspace_path TEXT,
      repo_path TEXT, branch_name TEXT, model_override TEXT, skills TEXT NOT NULL DEFAULT '[]',
      board_id TEXT NOT NULL DEFAULT 'default', idempotency_key TEXT, result TEXT, pending_mode TEXT,
      claim_lock TEXT, claim_expires INTEGER, worker_pid INTEGER, current_run_id INTEGER,
      last_heartbeat_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_failure_error TEXT, max_runtime_seconds INTEGER, max_retries INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`);
    raw
      .prepare(
        `INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, 'todo', ?, ?)`
      )
      .run('legacy1', 'old task', 1, 1);
    raw.pragma('user_version = 5');
    raw.close();

    const store = new KanbanStore(dbPath, { now: () => 1000 });
    expect(store.schemaVersion()).toBe(10);
    const t = store.getTask('legacy1');
    expect(t?.title).toBe('old task');
    expect(t?.scheduleKind).toBeNull();
    expect(t?.schedulePaused).toBe(false);
    expect(t?.nextRunAt).toBeNull();
    store.close();
  });
});

describe('KanbanStore scheduling', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('setSchedule (interval) sets columns, next_run_at, and scheduled status', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    const got = store.getTask(t.id)!;
    expect(got.status).toBe('scheduled');
    expect(got.scheduleKind).toBe('interval');
    expect(got.scheduleIntervalMs).toBe(5000);
    expect(got.nextRunAt).toBe(15_000);
    expect(got.schedulePaused).toBe(false);
    store.close();
  });

  it('setSchedule (once) sets next_run_at to the fixed time', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'one', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'once', at: 99_000 });
    const got = store.getTask(t.id)!;
    expect(got.status).toBe('scheduled');
    expect(got.scheduleKind).toBe('once');
    expect(got.nextRunAt).toBe(99_000);
    store.close();
  });

  it('clearSchedule returns the task to todo and nulls schedule columns', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    store.clearSchedule(t.id);
    const got = store.getTask(t.id)!;
    expect(got.status).toBe('todo');
    expect(got.scheduleKind).toBeNull();
    expect(got.nextRunAt).toBeNull();
    store.close();
  });

  it('pause/resume toggles schedule_paused', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    store.pauseSchedule(t.id);
    expect(store.getTask(t.id)!.schedulePaused).toBe(true);
    store.resumeSchedule(t.id);
    expect(store.getTask(t.id)!.schedulePaused).toBe(false);
    store.close();
  });

  it('dueSchedules returns only unpaused scheduled rows due at/before now', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const due = store.createTask({ title: 'due', assignee: 'r' });
    const future = store.createTask({ title: 'future', assignee: 'r' });
    const paused = store.createTask({ title: 'paused', assignee: 'r' });
    store.setSchedule(due.id, { kind: 'once', at: 9_000 });
    store.setSchedule(future.id, { kind: 'once', at: 11_000 });
    store.setSchedule(paused.id, { kind: 'once', at: 9_000 });
    store.pauseSchedule(paused.id);
    const ids = store.dueSchedules(10_000).map((t) => t.id);
    expect(ids).toEqual([due.id]);
    store.close();
  });

  it('fireOnce moves a scheduled task to ready and clears schedule columns', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'one', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'once', at: 9_000 });
    store.fireOnce(t.id);
    const got = store.getTask(t.id)!;
    expect(got.status).toBe('ready');
    expect(got.scheduleKind).toBeNull();
    store.close();
  });

  it('advanceNextRun updates next_run_at without changing status', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    store.advanceNextRun(t.id, 42_000);
    const got = store.getTask(t.id)!;
    expect(got.nextRunAt).toBe(42_000);
    expect(got.status).toBe('scheduled');
    store.close();
  });

  it('dropSchedule nulls schedule columns without changing status', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'x', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    store.setStatus(t.id, 'ready');
    store.dropSchedule(t.id);
    const got = store.getTask(t.id)!;
    expect(got.status).toBe('ready');
    expect(got.scheduleKind).toBeNull();
    expect(got.nextRunAt).toBeNull();
    expect(got.schedulePaused).toBe(false);
    store.close();
  });

  it('spawnScheduledInstance copies fields, inherits board, sets scheduled_from + todo', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const board = store.createBoard('Ops');
    const tmpl = store.createTask({
      title: 'nightly',
      body: 'do it',
      assignee: 'r',
      priority: 3,
      tenant: 'acme',
      boardId: board.slug,
      skills: ['a'],
      docs: ['guide.md'],
      maxRetries: 2
    });
    store.setSchedule(tmpl.id, { kind: 'interval', everyMs: 5000 });
    const inst = store.spawnScheduledInstance(store.getTask(tmpl.id)!);
    expect(inst.id).not.toBe(tmpl.id);
    expect(inst.status).toBe('todo');
    expect(inst.title).toBe('nightly');
    expect(inst.body).toBe('do it');
    expect(inst.assignee).toBe('r');
    expect(inst.priority).toBe(3);
    expect(inst.tenant).toBe('acme');
    expect(inst.boardId).toBe(board.slug);
    expect(inst.skills).toEqual(['a']);
    expect(inst.docs).toEqual(['guide.md']);
    expect(inst.maxRetries).toBe(2);
    expect(inst.scheduledFrom).toBe(tmpl.id);
    expect(inst.scheduleKind).toBeNull();
    store.close();
  });
});

describe('KanbanStore.transaction', () => {
  it('commits all writes when the function returns', () => {
    const store = new KanbanStore(join(TEST_DIR, `tx-ok-${Math.random()}.db`));
    const ids = store.transaction(() => {
      const a = store.createTask({ title: 'a' });
      const b = store.createTask({ title: 'b' });
      store.addLink(a.id, b.id);
      return [a.id, b.id];
    });
    expect(store.getTask(ids[0])).not.toBeNull();
    expect(store.getTask(ids[1])).not.toBeNull();
    expect(store.parentsOf(ids[1])).toEqual([ids[0]]);
  });

  it('rolls back every write when the function throws', () => {
    const store = new KanbanStore(join(TEST_DIR, `tx-rollback-${Math.random()}.db`));
    expect(() =>
      store.transaction(() => {
        store.createTask({ title: 'doomed' });
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(store.listTasks()).toHaveLength(0);
  });
});

describe('KanbanStore.promotableTodoTasks gate', () => {
  function fresh(): KanbanStore {
    return new KanbanStore(join(TEST_DIR, `gate-${Math.random()}.db`));
  }

  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('promotes a child whose only parent is done', () => {
    const store = fresh();
    const parent = store.createTask({ title: 'p', status: 'done' });
    const child = store.createTask({ title: 'c', status: 'todo' });
    store.addLink(parent.id, child.id);
    expect(store.promotableTodoTasks().map((t) => t.id)).toContain(child.id);
  });

  it('promotes a child whose only parent is archived', () => {
    const store = fresh();
    const parent = store.createTask({ title: 'p', status: 'archived' });
    const child = store.createTask({ title: 'c', status: 'todo' });
    store.addLink(parent.id, child.id);
    expect(store.promotableTodoTasks().map((t) => t.id)).toContain(child.id);
  });

  it('does NOT promote a child with a blocked parent', () => {
    const store = fresh();
    const parent = store.createTask({ title: 'p', status: 'blocked' });
    const child = store.createTask({ title: 'c', status: 'todo' });
    store.addLink(parent.id, child.id);
    expect(store.promotableTodoTasks().map((t) => t.id)).not.toContain(child.id);
  });

  it('does NOT promote until ALL parents are settled', () => {
    const store = fresh();
    const p1 = store.createTask({ title: 'p1', status: 'done' });
    const p2 = store.createTask({ title: 'p2', status: 'running' });
    const child = store.createTask({ title: 'c', status: 'todo' });
    store.addLink(p1.id, child.id);
    store.addLink(p2.id, child.id);
    expect(store.promotableTodoTasks().map((t) => t.id)).not.toContain(child.id);
  });
});

describe('KanbanStore attachments', () => {
  let store: KanbanStore;
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(DB_PATH);
  });
  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function src(name: string, body = 'data'): string {
    const p = join(TEST_DIR, name);
    writeFileSync(p, body);
    return p;
  }

  it('adds, lists, gets and removes an attachment', () => {
    const task = store.createTask({ title: 't' });
    const att = store.addAttachment(task.id, src('a.txt'));
    expect(att.filename).toBe('a.txt');
    expect(existsSync(att.storedPath)).toBe(true);

    const list = store.listAttachments(task.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(att.id);

    expect(store.getAttachment(att.id)?.storedPath).toBe(att.storedPath);

    store.removeAttachment(att.id);
    expect(store.listAttachments(task.id)).toHaveLength(0);
    expect(existsSync(att.storedPath)).toBe(false);
  });

  it('two uploads of the same filename coexist on disk', () => {
    const task = store.createTask({ title: 't' });
    const a = store.addAttachment(task.id, src('dup.txt', 'one'));
    const b = store.addAttachment(task.id, src('dup.txt', 'two'));
    expect(a.storedPath).not.toBe(b.storedPath);
    expect(store.listAttachments(task.id)).toHaveLength(2);
  });

  it('removeAttachment tolerates a missing on-disk file', () => {
    const task = store.createTask({ title: 't' });
    const att = store.addAttachment(task.id, src('gone.txt'));
    rmSync(att.storedPath, { force: true });
    expect(() => store.removeAttachment(att.id)).not.toThrow();
    expect(store.getAttachment(att.id)).toBeNull();
  });
});

describe('KanbanStore artifacts', () => {
  let store: KanbanStore;
  let ws: string;
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(DB_PATH, { now: () => 10_000 });
    ws = join(TEST_DIR, 'ws');
    mkdirSync(ws, { recursive: true });
  });
  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function write(rel: string, body = 'hello'): void {
    const full = join(ws, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }

  function register(taskId: string, boardId: string, relPath: string, opts: { title?: string } = {}) {
    return store.addArtifact({
      taskId,
      runId: 1,
      boardId,
      workspaceRoot: ws,
      relPath,
      title: opts.title ?? null
    });
  }

  it('registers, copies, lists and gets an artifact with guessed kind', () => {
    const task = store.createTask({ title: 't' });
    write('report.md', '# hi');
    const art = register(task.id, task.boardId, 'report.md', { title: 'Report' });
    expect(art.filename).toBe('report.md');
    expect(art.kind).toBe('document');
    expect(art.sourceRelPath).toBe('report.md');
    expect(art.state).toBe('kept');
    expect(existsSync(art.storedPath)).toBe(true);
    expect(store.listArtifacts(task.id)).toHaveLength(1);
    expect(store.getArtifact(art.id)?.title).toBe('Report');
  });

  it('persists nested source_rel_path and basenames the filename', () => {
    const task = store.createTask({ title: 't' });
    write('reports/out.csv', 'a,b');
    const art = register(task.id, task.boardId, 'reports/out.csv');
    expect(art.sourceRelPath).toBe('reports/out.csv');
    expect(art.filename).toBe('out.csv');
    expect(art.kind).toBe('data');
  });

  it('rejects traversal, absolute paths, symlinks and secrets', () => {
    const task = store.createTask({ title: 't' });
    write('ok.txt');
    expect(() => register(task.id, task.boardId, '../escape.txt')).toThrow();
    expect(() => register(task.id, task.boardId, '/etc/passwd')).toThrow();
    write('.env', 'SECRET=1');
    expect(() => register(task.id, task.boardId, '.env')).toThrow(/sensitive/);
    writeFileSync(join(TEST_DIR, 'outside.txt'), 'x');
    symlinkSync(join(TEST_DIR, 'outside.txt'), join(ws, 'link.txt'));
    expect(() => register(task.id, task.boardId, 'link.txt')).toThrow();
  });

  it('artifactCount on listBoard counts kept only', () => {
    const task = store.createTask({ title: 't' });
    write('a.md');
    write('b.md');
    const a = register(task.id, task.boardId, 'a.md');
    register(task.id, task.boardId, 'b.md');
    expect(store.listBoard().find((c) => c.id === task.id)?.artifactCount).toBe(2);
    store.discardArtifact(a.id);
    expect(store.listBoard().find((c) => c.id === task.id)?.artifactCount).toBe(1);
  });

  it('discard hides, restore un-hides', () => {
    const task = store.createTask({ title: 't' });
    write('a.md');
    const a = register(task.id, task.boardId, 'a.md');
    store.discardArtifact(a.id);
    expect(store.getArtifact(a.id)?.state).toBe('discarded');
    expect(store.getArtifact(a.id)?.discardedAt).toBe(10_000);
    store.restoreArtifact(a.id);
    expect(store.getArtifact(a.id)?.state).toBe('kept');
    expect(store.getArtifact(a.id)?.discardedAt).toBeNull();
  });

  it('purgeDiscardedBefore removes old discarded artifacts and returns metadata', () => {
    const task = store.createTask({ title: 't' });
    write('a.md');
    write('b.md');
    const a = register(task.id, task.boardId, 'a.md');
    const b = register(task.id, task.boardId, 'b.md');
    store.discardArtifact(a.id); // discarded_at = 10_000
    const purged = store.purgeDiscardedBefore(10_001);
    expect(purged.map((p) => p.id)).toEqual([a.id]);
    expect(existsSync(a.storedPath)).toBe(false);
    expect(store.getArtifact(a.id)).toBeNull();
    expect(store.getArtifact(b.id)?.state).toBe('kept'); // kept untouched
  });

  it('deleteBoard removes artifact rows and files', () => {
    const board = store.createBoard('Side');
    const task = store.createTask({ title: 't', boardId: board.slug });
    write('a.md');
    const a = register(task.id, board.slug, 'a.md');
    expect(existsSync(a.storedPath)).toBe(true);
    store.deleteBoard(board.slug);
    expect(store.getArtifact(a.id)).toBeNull();
    expect(existsSync(a.storedPath)).toBe(false);
  });

  it('listAllArtifacts joins task/board and filters by state', () => {
    const task = store.createTask({ title: 'My Task' });
    write('a.md');
    write('b.md');
    const a = register(task.id, task.boardId, 'a.md');
    register(task.id, task.boardId, 'b.md');
    store.discardArtifact(a.id);
    const all = store.listAllArtifacts();
    expect(all).toHaveLength(2);
    expect(all[0].taskTitle).toBe('My Task');
    expect(all[0].boardName).toBe('Default');
    expect(store.listAllArtifacts({ state: 'kept' })).toHaveLength(1);
    expect(store.listAllArtifacts({ state: 'discarded' })).toHaveLength(1);
  });

  it('createTaskFromArtifact attaches a copy and references it in the body', () => {
    const task = store.createTask({ title: 'src' });
    write('a.md', 'payload');
    const a = register(task.id, task.boardId, 'a.md');
    const seeded = store.createTaskFromArtifact(a.id, { title: 'seeded', body: 'do it' });
    const atts = store.listAttachments(seeded.id);
    expect(atts).toHaveLength(1);
    expect(existsSync(atts[0].storedPath)).toBe(true);
    expect(store.getTask(seeded.id)?.body).toMatch(/Seeded from artifact: a\.md/);
  });

  it('createTaskFromArtifact refuses a discarded artifact', () => {
    const task = store.createTask({ title: 'src' });
    write('a.md');
    const a = register(task.id, task.boardId, 'a.md');
    store.discardArtifact(a.id);
    expect(() => store.createTaskFromArtifact(a.id, { title: 'x' })).toThrow(/kept/);
  });
});

describe('projects schema (v10)', () => {
  let store: KanbanStore;
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(DB_PATH);
  });
  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('migrates to v10 with a projects table and tasks.docs column', () => {
    expect(store.schemaVersion()).toBe(10);
    const t = store.createTask({ title: 'x' });
    expect(t.docs).toEqual([]);
    expect(store.listProjects('default')).toEqual([]);
  });

  it('first project added becomes the default', () => {
    const p = store.addProject({ boardId: 'default', name: 'fleet', path: '/tmp/a' });
    expect(p.isDefault).toBe(true);
    const q = store.addProject({ boardId: 'default', name: 'site', path: '/tmp/b' });
    expect(q.isDefault).toBe(false);
  });

  it('setDefaultProject moves the default within a board', () => {
    const p = store.addProject({ boardId: 'default', name: 'fleet', path: '/tmp/a' });
    const q = store.addProject({ boardId: 'default', name: 'site', path: '/tmp/b' });
    store.setDefaultProject(q.id);
    const byName = Object.fromEntries(store.listProjects('default').map((x) => [x.name, x]));
    expect(byName.fleet.isDefault).toBe(false);
    expect(byName.site.isDefault).toBe(true);
    void p;
  });

  it('removing the default promotes the oldest remaining project', () => {
    const p = store.addProject({ boardId: 'default', name: 'fleet', path: '/tmp/a' });
    store.addProject({ boardId: 'default', name: 'site', path: '/tmp/b' });
    store.removeProject(p.id);
    const rest = store.listProjects('default');
    expect(rest).toHaveLength(1);
    expect(rest[0].name).toBe('site');
    expect(rest[0].isDefault).toBe(true);
  });

  it('getProjectByName resolves within the board only', () => {
    store.addProject({ boardId: 'default', name: 'fleet', path: '/tmp/a' });
    expect(store.getProjectByName('default', 'fleet')?.path).toBe('/tmp/a');
    expect(store.getProjectByName('other', 'fleet')).toBeNull();
  });

  it('deleteBoard removes the board projects', () => {
    const b = store.createBoard('Temp');
    store.addProject({ boardId: b.slug, name: 'x', path: '/tmp/x' });
    store.deleteBoard(b.slug);
    expect(store.listProjects(b.slug)).toEqual([]);
  });
});
