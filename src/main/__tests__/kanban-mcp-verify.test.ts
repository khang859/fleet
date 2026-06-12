import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanMcpServer, type VerifyRunner } from '../kanban/kanban-mcp-server';

const TEST_DIR = join(tmpdir(), `fleet-mcp-verify-${Date.now()}`);

async function rpc(url: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return res.json();
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

describe('kanban_complete verify gate', () => {
  let store: KanbanStore;
  let server: KanbanMcpServer;
  let base: string;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(join(TEST_DIR, `v-${Math.random()}.db`));
    server = new KanbanMcpServer(store);
    const port = await server.start(0);
    base = `http://127.0.0.1:${port}/mcp`;
  });
  afterEach(async () => {
    await server.stop();
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function worktreeTask(repo: string) {
    const t = store.createTask({
      title: 'x',
      status: 'ready',
      assignee: 'r',
      workspaceKind: 'worktree',
      workspacePath: repo,
      repoPath: repo,
      branchName: 'kanban/x',
      baseBranch: 'main'
    });
    store.claimTask(t.id, 'LOCK', 100000);
    const run = store.startRun(t.id, 'r', 1, 'work');
    server.registerRun('tok', { kind: 'task', taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
    return t;
  }

  it('starts a verify run and holds the task in running when the project has verify_commands', async () => {
    const repo = makeRepo('gated');
    const p = store.addProject({ boardId: 'default', name: 'app', path: repo });
    store.setProjectVerifyCommands(p.id, [{ label: 'tc', command: 'true' }]);
    const t = worktreeTask(repo);

    const seen: Array<Parameters<VerifyRunner>[0]> = [];
    server.setVerifyRunner((args) => {
      seen.push(args);
      return 4242;
    });

    const r = await rpc(`${base}?run=tok`, 'tools/call', {
      name: 'kanban_complete',
      arguments: { summary: 's' }
    });
    expect(String(r.result.content[0].text)).toMatch(/verif/i);
    const after = store.getTask(t.id)!;
    expect(after.status).toBe('running');
    expect(after.workerPid).toBe(4242);
    expect(after.currentRunId != null && store.runMode(after.currentRunId)).toBe('verify');
    expect(seen[0]?.commands).toEqual([{ label: 'tc', command: 'true' }]);
    expect(seen[0]?.workspace).toBe(repo);
  });

  it('lands the task in review (old path) when the project has no verify_commands', async () => {
    const repo = makeRepo('ungated');
    store.addProject({ boardId: 'default', name: 'app', path: repo }); // no verify commands
    const t = worktreeTask(repo);
    server.setVerifyRunner(() => 4242); // present but must not be used

    await rpc(`${base}?run=tok`, 'tools/call', {
      name: 'kanban_complete',
      arguments: { summary: 's' }
    });
    expect(store.getTask(t.id)?.status).toBe('review');
  });
});
