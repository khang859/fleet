import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanMcpServer } from '../kanban/kanban-mcp-server';
import { createSwarm } from '../kanban/kanban-swarm';

const TEST_DIR = join(tmpdir(), `fleet-kanban-mcp-test-${Date.now()}`);

async function rpc(url: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return res.json();
}

describe('KanbanMcpServer', () => {
  let store: KanbanStore;
  let server: KanbanMcpServer;
  let base: string;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(join(TEST_DIR, 'mcp.db'));
    server = new KanbanMcpServer(store);
    const port = await server.start(0); // 0 = ephemeral port
    base = `http://127.0.0.1:${port}/mcp`;
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('responds to initialize', async () => {
    const r = await rpc(base, 'initialize', { protocolVersion: '2024-11-05' });
    expect(r.result.protocolVersion).toBe('2024-11-05');
    expect(r.result.serverInfo.name).toBe('fleet-kanban');
  });

  it('lists worker tools', async () => {
    const r = await rpc(base, 'tools/list');
    const names = r.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('kanban_complete');
    expect(names).toContain('kanban_block');
    expect(names).toContain('kanban_comment');
    expect(names).toContain('kanban_heartbeat');
    expect(names).toContain('kanban_show');
  });

  it('rejects a tools/call with an unknown run token', async () => {
    const r = await rpc(`${base}?run=bogus`, 'tools/call', {
      name: 'kanban_show',
      arguments: {}
    });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/run token/i);
  });

  it('kanban_complete marks the task done and finishes the run', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'LOCK', 100000);
    const run = store.startRun(t.id, 'r', 1);
    server.registerRun('tok1', { taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');

    const r = await rpc(`${base}?run=tok1`, 'tools/call', {
      name: 'kanban_complete',
      arguments: { summary: 'shipped it', metadata: { files: 3 } }
    });
    expect(r.result.content[0].text).toMatch(/done/i);
    expect(store.getTask(t.id)?.status).toBe('done');
    expect(store.getTask(t.id)?.result).toBe('shipped it');
    const runs = store.listRuns(t.id);
    expect(runs[0].outcome).toBe('completed');
  });

  it('kanban_block blocks the task', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'LOCK', 100000);
    const run = store.startRun(t.id, 'r', 1);
    server.registerRun('tok2', { taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
    await rpc(`${base}?run=tok2`, 'tools/call', {
      name: 'kanban_block',
      arguments: { reason: 'review-required: see comment' }
    });
    expect(store.getTask(t.id)?.status).toBe('blocked');
  });

  it('kanban_comment appends a comment authored by the assignee', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'researcher' });
    const run = store.startRun(t.id, 'researcher', 1);
    server.registerRun('tok3', { taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
    await rpc(`${base}?run=tok3`, 'tools/call', {
      name: 'kanban_comment',
      arguments: { body: 'progress note' }
    });
    const comments = store.listComments(t.id);
    expect(comments[0].body).toBe('progress note');
    expect(comments[0].author).toBe('researcher');
  });

  it('kanban_heartbeat extends the claim for the lock holder', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'LOCK', 1000);
    const before = store.getTask(t.id)?.claimExpires ?? 0;
    const run = store.startRun(t.id, 'r', 1);
    server.registerRun('tok4', { taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
    await rpc(`${base}?run=tok4`, 'tools/call', { name: 'kanban_heartbeat', arguments: {} });
    const after = store.getTask(t.id)?.claimExpires ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('kanban_show returns the task title and body', async () => {
    const t = store.createTask({
      title: 'My task',
      body: 'do the thing',
      status: 'ready',
      assignee: 'r'
    });
    const run = store.startRun(t.id, 'r', 1);
    server.registerRun('tok5', { taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
    const r = await rpc(`${base}?run=tok5`, 'tools/call', { name: 'kanban_show', arguments: {} });
    expect(r.result.content[0].text).toMatch(/My task/);
    expect(r.result.content[0].text).toMatch(/do the thing/);
  });

  it('writes a task_event for each tool call', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    const run = store.startRun(t.id, 'r', 1);
    server.registerRun('tok6', { taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
    await rpc(`${base}?run=tok6`, 'tools/call', {
      name: 'kanban_comment',
      arguments: { body: 'x' }
    });
    const kinds = store.listEvents(t.id).map((e) => e.kind);
    expect(kinds).toContain('comment');
  });

  it('unregisters the run token after kanban_complete (token no longer valid)', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'LOCK', 100000);
    const run = store.startRun(t.id, 'r', 1);
    server.registerRun('tokX', { taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
    await rpc(`${base}?run=tokX`, 'tools/call', {
      name: 'kanban_complete',
      arguments: { summary: 's' }
    });
    // token must now be rejected
    const r = await rpc(`${base}?run=tokX`, 'tools/call', { name: 'kanban_show', arguments: {} });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/run token/i);
  });

  it('tools/list returns decompose tools for a decompose-mode token', async () => {
    const t = store.createTask({ title: 'big', status: 'running' });
    const run = store.startRun(t.id, 'orchestrator', 1, 'decompose');
    server.registerRun('dtok', { taskId: t.id, runId: run.id, mode: 'decompose' }, 'L');
    const r = await rpc(`${base}?run=dtok`, 'tools/list');
    const names = r.result.tools.map((x: { name: string }) => x.name);
    expect(names).toContain('kanban_create');
    expect(names).toContain('kanban_link');
    expect(names).toContain('kanban_list');
    expect(names).not.toContain('kanban_update');
  });

  it('a worker-mode token cannot call kanban_create', async () => {
    const t = store.createTask({ title: 'x', status: 'running', assignee: 'r' });
    const run = store.startRun(t.id, 'r', 1, 'work');
    server.registerRun('wtok', { taskId: t.id, runId: run.id, mode: 'work' }, 'L');
    const r = await rpc(`${base}?run=wtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'child' }
    });
    expect(String(r.error?.message ?? '')).toMatch(/unknown tool/i);
  });

  it('kanban_create makes a todo child linked to the orchestrator task', async () => {
    const parent = store.createTask({ title: 'big', status: 'running' });
    const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
    server.registerRun('dtok2', { taskId: parent.id, runId: run.id, mode: 'decompose' }, 'L');
    const r = await rpc(`${base}?run=dtok2`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'child task', assignee: 'default' }
    });
    const childId = String(r.result.content[0].text).trim();
    const child = store.getTask(childId);
    expect(child?.status).toBe('todo');
    expect(child?.assignee).toBe('default');
    expect(store.parentsOf(childId)).toContain(parent.id);
    expect(store.listEvents(childId).some((e) => e.kind === 'task_created')).toBe(true);
  });

  it('kanban_create makes children inherit the parent board', async () => {
    store.createBoard('Research');
    const parent = store.createTask({ title: 'p', status: 'running', boardId: 'research' });
    const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
    server.registerRun('btok', { taskId: parent.id, runId: run.id, mode: 'decompose' }, 'L');
    const r = await rpc(`${base}?run=btok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'child' }
    });
    const childId = String(r.result.content[0].text).trim();
    const child = store.getTask(childId);
    expect(child?.boardId).toBe('research');
  });

  it('kanban_create makes worktree children that inherit the parent repo', async () => {
    const parent = store.createTask({
      title: 'big',
      status: 'running',
      workspaceKind: 'worktree',
      repoPath: '/src/myrepo'
    });
    const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
    server.registerRun('itok', { taskId: parent.id, runId: run.id, mode: 'decompose' }, 'L');
    const r = await rpc(`${base}?run=itok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'child' }
    });
    const childId = String(r.result.content[0].text).trim();
    const child = store.getTask(childId);
    expect(child?.workspaceKind).toBe('worktree');
    expect(child?.repoPath).toBe('/src/myrepo');
  });

  it('kanban_create leaves children as scratch when the parent is not a worktree', async () => {
    const parent = store.createTask({ title: 'big', status: 'running' });
    const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
    server.registerRun('itok2', { taskId: parent.id, runId: run.id, mode: 'decompose' }, 'L');
    const r = await rpc(`${base}?run=itok2`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'child' }
    });
    const childId = String(r.result.content[0].text).trim();
    const child = store.getTask(childId);
    expect(child?.workspaceKind).toBe('scratch');
    expect(child?.repoPath).toBeNull();
  });

  it('kanban_create does not make a worktree child when the parent has no repoPath', async () => {
    const parent = store.createTask({
      title: 'big',
      status: 'running',
      workspaceKind: 'worktree'
      // repoPath intentionally omitted
    });
    const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
    server.registerRun('itok3', { taskId: parent.id, runId: run.id, mode: 'decompose' }, 'L');
    const r = await rpc(`${base}?run=itok3`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'child' }
    });
    const childId = String(r.result.content[0].text).trim();
    const child = store.getTask(childId);
    expect(child?.workspaceKind).toBe('scratch');
    expect(child?.repoPath).toBeNull();
  });

  it('kanban_create honors extra parents', async () => {
    const parent = store.createTask({ title: 'big', status: 'running' });
    const dep = store.createTask({ title: 'dep', status: 'todo' });
    const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
    server.registerRun('dtok3', { taskId: parent.id, runId: run.id, mode: 'decompose' }, 'L');
    const r = await rpc(`${base}?run=dtok3`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'child', parents: [dep.id] }
    });
    const childId = String(r.result.content[0].text).trim();
    expect(store.parentsOf(childId).sort()).toEqual([dep.id, parent.id].sort());
  });

  it('kanban_update (specify) rewrites the body and returns the task to todo', async () => {
    const t = store.createTask({ title: 'vague', body: 'old', status: 'running' });
    const run = store.startRun(t.id, 'orchestrator', 1, 'specify');
    server.registerRun('stok', { taskId: t.id, runId: run.id, mode: 'specify' }, 'L');
    const r = await rpc(`${base}?run=stok`, 'tools/call', {
      name: 'kanban_update',
      arguments: { title: 'clear title', body: 'a much fuller spec' }
    });
    expect(r.result.content[0].text).toMatch(/specified/i);
    const got = store.getTask(t.id);
    expect(got?.status).toBe('todo');
    expect(got?.body).toBe('a much fuller spec');
    expect(got?.title).toBe('clear title');
    expect(got?.claimLock).toBeNull();
  });

  it('kanban_swarm_post then kanban_swarm_read round-trips on a swarm root', async () => {
    const created = createSwarm(store, {
      goal: 'g',
      workers: [{ profile: 'w', title: 't', body: 't', skills: [] }],
      verifierAssignee: 'v',
      synthesizerAssignee: 'y'
    });
    const workerId = created.workerIds[0];
    store.setStatus(workerId, 'ready');
    store.claimTask(workerId, 'LOCK', 100000);
    const run = store.startRun(workerId, 'w', 1);
    server.registerRun('toksw', { taskId: workerId, runId: run.id, mode: 'work' }, 'LOCK');

    const post = await rpc(`${base}?run=toksw`, 'tools/call', {
      name: 'kanban_swarm_post',
      arguments: { root: created.rootId, key: 'finding', value: { ok: true } }
    });
    expect(post.result.content[0].text).toMatch(/updated/i);

    const read = await rpc(`${base}?run=toksw`, 'tools/call', {
      name: 'kanban_swarm_read',
      arguments: { root: created.rootId }
    });
    const bb = JSON.parse(read.result.content[0].text);
    expect(bb.finding).toEqual({ ok: true });
    expect(bb.topology.kind).toBe('kanban_swarm_v1');
  });

  it('kanban_swarm_post rejects the reserved _authors key', async () => {
    const created = createSwarm(store, {
      goal: 'g',
      workers: [{ profile: 'w', title: 't', body: 't', skills: [] }],
      verifierAssignee: 'v',
      synthesizerAssignee: 'y'
    });
    const workerId = created.workerIds[0];
    store.setStatus(workerId, 'ready');
    store.claimTask(workerId, 'LOCK', 100000);
    const run = store.startRun(workerId, 'w', 1);
    server.registerRun('tokres', { taskId: workerId, runId: run.id, mode: 'work' }, 'LOCK');
    const r = await rpc(`${base}?run=tokres`, 'tools/call', {
      name: 'kanban_swarm_post',
      arguments: { root: created.rootId, key: '_authors', value: 'x' }
    });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/reserved/i);
  });

  it('kanban_swarm creation routes through the injected handler with the scope board', async () => {
    let receivedBoard: string | undefined;
    server.setSwarmHandler((input) => {
      receivedBoard = input.boardId;
      return { rootId: 'r1', workerIds: ['w1'], verifierId: 'v1', synthesizerId: 's1' };
    });
    const orch = store.createTask({
      title: 'orch',
      status: 'ready',
      assignee: 'orchestrator',
      boardId: 'default'
    });
    store.claimTask(orch.id, 'LOCK', 100000);
    const run = store.startRun(orch.id, 'orchestrator', 1);
    server.registerRun('tokorch', { taskId: orch.id, runId: run.id, mode: 'decompose' }, 'LOCK');

    const r = await rpc(`${base}?run=tokorch`, 'tools/call', {
      name: 'kanban_swarm',
      arguments: {
        goal: 'plan it',
        workers: [{ profile: 'researcher', title: 'Research' }],
        verifier: 'reviewer',
        synthesizer: 'writer'
      }
    });
    const out = JSON.parse(r.result.content[0].text);
    expect(out.rootId).toBe('r1');
    expect(out.workerIds).toEqual(['w1']);
    expect(receivedBoard).toBe('default');
  });

  it('kanban_swarm_read rejects a non-swarm-root id', async () => {
    const plain = store.createTask({ title: 'plain', status: 'ready', assignee: 'r' });
    store.claimTask(plain.id, 'LOCK', 100000);
    const run = store.startRun(plain.id, 'r', 1);
    server.registerRun('tokplain', { taskId: plain.id, runId: run.id, mode: 'work' }, 'LOCK');

    const r = await rpc(`${base}?run=tokplain`, 'tools/call', {
      name: 'kanban_swarm_read',
      arguments: { root: plain.id }
    });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/not a swarm root/i);
  });
});
