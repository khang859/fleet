import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanMcpServer, type RunScope } from '../kanban/kanban-mcp-server';

const TEST_DIR = join(tmpdir(), `fleet-review-mcp-${Date.now()}`);

let REPO: string;

async function rpc(url: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return res.json();
}

describe('kanban_review_verdict', () => {
  let store: KanbanStore;
  let server: KanbanMcpServer;
  let base: string;

  // makeServer mirrors the verify-test harness but returns store + server so each
  // test can register its own run token; base url is captured per suite.
  function makeServer() {
    return { store, server };
  }

  // register binds a per-run token to a scope (real registerRun) and returns it.
  function register(srv: KanbanMcpServer, scope: Extract<RunScope, { kind: 'task' }>): string {
    const token = `tok-${Math.random()}`;
    srv.registerRun(token, scope);
    return token;
  }

  // call invokes a tool over real HTTP and returns the raw json-rpc envelope
  // ({ result } on success, { error } on a tool error — matching the server's rpcError).
  async function call(
    _srv: KanbanMcpServer,
    token: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<any> {
    return rpc(`${base}?run=${token}`, 'tools/call', { name, arguments: args });
  }

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    REPO = mkdtempSync(join(TEST_DIR, 'repo-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', REPO, ...a]);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(REPO, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'base');

    store = new KanbanStore(join(TEST_DIR, `v-${Math.random()}.db`));
    server = new KanbanMcpServer(store);
    const port = await server.start(0);
    base = `http://127.0.0.1:${port}/mcp`;
  });
  afterEach(async () => {
    await server.stop();
    store.close();
  });

  it('approve records verdict + head sha + reviewer comment + review_passed event', async () => {
    const { store, server } = makeServer();
    const t = store.createTask({
      title: 'x',
      status: 'running',
      workspaceKind: 'worktree',
      assignee: 'w'
    });
    store.setWorkspace(t.id, REPO, 'b', 'main');
    const run = store.startRun(t.id, 'reviewer', 1, 'review');
    store.setWorkerPid(t.id, run.id, 1);
    const token = register(server, { kind: 'task', taskId: t.id, runId: run.id, mode: 'review' });
    await call(server, token, 'kanban_review_verdict', { decision: 'approve', summary: 'lgtm' });
    const got = store.getTask(t.id)!;
    expect(got.reviewVerdict).toBe('approve');
    expect(got.reviewHeadSha).toMatch(/^[0-9a-f]{7,}/);
    expect(got.status).toBe('running'); // does NOT clear current_run_id; reclaim routes next tick
    expect(got.currentRunId).toBe(run.id);
    expect(store.listComments(t.id).some((c) => c.author === 'reviewer')).toBe(true);
    expect(store.listEvents(t.id).some((e) => e.kind === 'review_passed')).toBe(true);
  });

  it('request_changes records findings + review_changes_requested event', async () => {
    const { store, server } = makeServer();
    const t = store.createTask({
      title: 'x',
      status: 'running',
      workspaceKind: 'worktree',
      assignee: 'w'
    });
    store.setWorkspace(t.id, REPO, 'b', 'main');
    const run = store.startRun(t.id, 'reviewer', 1, 'review');
    const token = register(server, { kind: 'task', taskId: t.id, runId: run.id, mode: 'review' });
    await call(server, token, 'kanban_review_verdict', {
      decision: 'request_changes',
      summary: 'fix it',
      findings: [{ file: 'a.ts', note: 'null check' }]
    });
    expect(store.getTask(t.id)!.reviewVerdict).toBe('request_changes');
    const ev = store.listEvents(t.id).find((e) => e.kind === 'review_changes_requested');
    expect(ev).toBeTruthy();
  });

  it('rejects an invalid decision and an empty summary', async () => {
    const { store, server } = makeServer();
    const t = store.createTask({ title: 'x', status: 'running', workspaceKind: 'worktree' });
    const run = store.startRun(t.id, 'reviewer', 1, 'review');
    const token = register(server, { kind: 'task', taskId: t.id, runId: run.id, mode: 'review' });
    const r1 = await call(server, token, 'kanban_review_verdict', {
      decision: 'nope',
      summary: 'x'
    });
    expect(r1.error ?? r1.isError).toBeTruthy();
    const r2 = await call(server, token, 'kanban_review_verdict', {
      decision: 'approve',
      summary: ''
    });
    expect(r2.error ?? r2.isError).toBeTruthy();
  });

  it('CAS guard: a verdict for a non-current run is a no-op', async () => {
    const { store, server } = makeServer();
    const t = store.createTask({ title: 'x', status: 'running', workspaceKind: 'worktree' });
    const stale = store.startRun(t.id, 'reviewer', 1, 'review');
    const current = store.startRun(t.id, 'reviewer', 2, 'review'); // current_run_id now = current.id
    expect(current.id).not.toBe(stale.id);
    const token = register(server, { kind: 'task', taskId: t.id, runId: stale.id, mode: 'review' });
    await call(server, token, 'kanban_review_verdict', { decision: 'approve', summary: 'x' });
    expect(store.getTask(t.id)!.reviewVerdict).toBeNull();
  });

  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));
});
