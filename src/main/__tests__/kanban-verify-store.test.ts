import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';

const TEST_DIR = join(tmpdir(), `fleet-verify-store-${Date.now()}`);

function makeStore(): KanbanStore {
  let t = 1000;
  return new KanbanStore(join(TEST_DIR, `s-${Math.random()}.db`), { now: () => (t += 1) });
}

describe('verify-gate store', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('round-trips verify_commands on a project and finds it by path', () => {
    const store = makeStore();
    const dir = mkdtempSync(join(TEST_DIR, 'repo-'));
    const p = store.addProject({ boardId: 'default', name: 'app', path: dir });
    expect(p.verifyCommands).toEqual([]);
    store.setProjectVerifyCommands(p.id, [
      { label: 'typecheck', command: 'npm run typecheck' },
      { label: 'tests', command: 'npm test' }
    ]);
    const byPath = store.getProjectByPath('default', dir);
    expect(byPath?.verifyCommands).toEqual([
      { label: 'typecheck', command: 'npm run typecheck' },
      { label: 'tests', command: 'npm test' }
    ]);
    store.close();
  });

  it('getProjectByPath normalizes trailing-slash differences', () => {
    const store = makeStore();
    const dir = mkdtempSync(join(TEST_DIR, 'repo-'));
    const p = store.addProject({ boardId: 'default', name: 'app', path: dir });
    expect(store.getProjectByPath('default', dir + '/')?.id).toBe(p.id);
    store.close();
  });

  it('malformed verify_commands JSON reads back as []', () => {
    const store = makeStore();
    const dir = mkdtempSync(join(TEST_DIR, 'repo-'));
    const p = store.addProject({ boardId: 'default', name: 'app', path: dir });
    store.rawDbForTest().prepare('UPDATE projects SET verify_commands=? WHERE id=?').run('not json', p.id);
    expect(store.getProject(p.id)?.verifyCommands).toEqual([]);
    store.close();
  });

  it('incrementVerifyAttempts bumps the counter', () => {
    const store = makeStore();
    const t = store.createTask({ title: 'x', status: 'running' });
    expect(store.getTask(t.id)?.verifyAttempts).toBe(0);
    store.incrementVerifyAttempts(t.id);
    expect(store.getTask(t.id)?.verifyAttempts).toBe(1);
    store.close();
  });

  it('resetVerifyAttempts clears the counter', () => {
    const store = makeStore();
    const t = store.createTask({ title: 'x', status: 'running' });
    store.incrementVerifyAttempts(t.id);
    store.incrementVerifyAttempts(t.id);
    expect(store.getTask(t.id)?.verifyAttempts).toBe(2);
    store.resetVerifyAttempts(t.id);
    expect(store.getTask(t.id)?.verifyAttempts).toBe(0);
    store.close();
  });

  it('orchestratorRunningCount excludes verify runs', () => {
    const store = makeStore();
    const t = store.createTask({ title: 'x', status: 'running' });
    store.startRun(t.id, null, 111, 'verify');
    expect(store.orchestratorRunningCount()).toBe(0);
    store.close();
  });

  it('claimForVerifyFix re-claims a running task with a fresh lock', () => {
    const store = makeStore();
    const t = store.createTask({ title: 'x', status: 'running' });
    expect(store.claimForVerifyFix(t.id, 'NL', 1000)).toBe(true);
    expect(store.getTask(t.id)?.claimLock).toBe('NL');
    const t2 = store.createTask({ title: 'y', status: 'review' });
    expect(store.claimForVerifyFix(t2.id, 'NL', 1000)).toBe(false);
    store.close();
  });
});
