import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanMcpServer } from '../kanban/kanban-mcp-server';

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
    server.registerRun('tok1', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');

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
    server.registerRun('tok2', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');
    await rpc(`${base}?run=tok2`, 'tools/call', {
      name: 'kanban_block',
      arguments: { reason: 'review-required: see comment' }
    });
    expect(store.getTask(t.id)?.status).toBe('blocked');
  });

  it('kanban_comment appends a comment authored by the assignee', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'researcher' });
    const run = store.startRun(t.id, 'researcher', 1);
    server.registerRun('tok3', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');
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
    server.registerRun('tok4', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');
    await rpc(`${base}?run=tok4`, 'tools/call', { name: 'kanban_heartbeat', arguments: {} });
    const after = store.getTask(t.id)?.claimExpires ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('kanban_show returns the task title and body', async () => {
    const t = store.createTask({ title: 'My task', body: 'do the thing', status: 'ready', assignee: 'r' });
    const run = store.startRun(t.id, 'r', 1);
    server.registerRun('tok5', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');
    const r = await rpc(`${base}?run=tok5`, 'tools/call', { name: 'kanban_show', arguments: {} });
    expect(r.result.content[0].text).toMatch(/My task/);
    expect(r.result.content[0].text).toMatch(/do the thing/);
  });

  it('writes a task_event for each tool call', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    const run = store.startRun(t.id, 'r', 1);
    server.registerRun('tok6', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');
    await rpc(`${base}?run=tok6`, 'tools/call', { name: 'kanban_comment', arguments: { body: 'x' } });
    const kinds = store.listEvents(t.id).map((e) => e.kind);
    expect(kinds).toContain('comment');
  });

  it('unregisters the run token after kanban_complete (token no longer valid)', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'LOCK', 100000);
    const run = store.startRun(t.id, 'r', 1);
    server.registerRun('tokX', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');
    await rpc(`${base}?run=tokX`, 'tools/call', { name: 'kanban_complete', arguments: { summary: 's' } });
    // token must now be rejected
    const r = await rpc(`${base}?run=tokX`, 'tools/call', { name: 'kanban_show', arguments: {} });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/run token/i);
  });
});
