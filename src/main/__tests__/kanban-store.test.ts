import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
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
    expect(store.schemaVersion()).toBe(2);
  });

  it('fresh db is created at v2 with the new columns', () => {
    // Fresh store is already v2; assert the new columns exist and are nullable/defaulted.
    const t = store.createTask({ title: 'x' });
    expect(store.getTask(t.id)?.pendingMode).toBeNull();
    const run = store.startRun(t.id, 'p', null);
    expect(run.mode).toBe('work');
    expect(store.schemaVersion()).toBe(2);
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
    expect(s.schemaVersion()).toBe(2);
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
