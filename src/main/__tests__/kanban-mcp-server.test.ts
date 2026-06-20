import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanMcpServer } from '../kanban/kanban-mcp-server';
import { KanbanDispatcher } from '../kanban/kanban-dispatcher';
import { KanbanCommands } from '../kanban/kanban-commands';
import { createSwarm } from '../kanban/kanban-swarm';
import { expandTemplate } from '../kanban/template-expander';
import { FULL_FEATURE, MAX_FANOUT } from '../kanban/pipeline-templates';
import { LearningsStore } from '../learnings/learnings-store';

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
    server.registerRun('tok1', { kind: 'task', taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');

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
    server.registerRun('tok2', { kind: 'task', taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
    await rpc(`${base}?run=tok2`, 'tools/call', {
      name: 'kanban_block',
      arguments: { reason: 'review-required: see comment' }
    });
    expect(store.getTask(t.id)?.status).toBe('blocked');
  });

  it('kanban_comment appends a comment authored by the assignee', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'researcher' });
    const run = store.startRun(t.id, 'researcher', 1);
    server.registerRun('tok3', { kind: 'task', taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
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
    server.registerRun('tok4', { kind: 'task', taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
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
    server.registerRun('tok5', { kind: 'task', taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
    const r = await rpc(`${base}?run=tok5`, 'tools/call', { name: 'kanban_show', arguments: {} });
    expect(r.result.content[0].text).toMatch(/My task/);
    expect(r.result.content[0].text).toMatch(/do the thing/);
  });

  it('writes a task_event for each tool call', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    const run = store.startRun(t.id, 'r', 1);
    server.registerRun('tok6', { kind: 'task', taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
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
    server.registerRun('tokX', { kind: 'task', taskId: t.id, runId: run.id, mode: 'work' }, 'LOCK');
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
    server.registerRun(
      'dtok',
      { kind: 'task', taskId: t.id, runId: run.id, mode: 'decompose' },
      'L'
    );
    const r = await rpc(`${base}?run=dtok`, 'tools/list');
    const names = r.result.tools.map((x: { name: string }) => x.name);
    expect(names).toContain('kanban_create');
    expect(names).toContain('kanban_link');
    expect(names).toContain('kanban_list');
    expect(names).not.toContain('kanban_update');
  });

  it('resolve mode exposes show/comment/heartbeat/complete/block and not create/assign', async () => {
    const t = store.createTask({ title: 'fix conflicts', status: 'running' });
    const run = store.startRun(t.id, 'r', 1, 'resolve');
    server.registerRun(
      'rstok',
      { kind: 'task', taskId: t.id, runId: run.id, mode: 'resolve' },
      'L'
    );
    const r = await rpc(`${base}?run=rstok`, 'tools/list');
    const names = r.result.tools.map((x: { name: string }) => x.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'kanban_show',
        'kanban_comment',
        'kanban_heartbeat',
        'kanban_complete',
        'kanban_block'
      ])
    );
    expect(names).not.toContain('kanban_create');
    expect(names).not.toContain('kanban_assign');
    // resolve is a tightly scoped retry — no swarm/artifact tooling.
    expect(names).not.toContain('kanban_artifact');
    expect(names).not.toContain('kanban_swarm_read');
  });

  it('kanban_complete on a resolve run returns the task to review', async () => {
    const t = store.createTask({
      title: 'retry merge',
      status: 'running',
      workspaceKind: 'worktree',
      workspacePath: join(TEST_DIR, 'no-such-worktree')
    });
    store.claimTask(t.id, 'LOCK', 100000);
    const run = store.startRun(t.id, 'r', 1, 'resolve');
    server.registerRun(
      'rctok',
      { kind: 'task', taskId: t.id, runId: run.id, mode: 'resolve' },
      'LOCK'
    );
    await rpc(`${base}?run=rctok`, 'tools/call', {
      name: 'kanban_complete',
      arguments: { summary: 'resolved' }
    });
    expect(store.getTask(t.id)?.status).toBe('review');
  });

  it('a worker-mode token cannot call kanban_create', async () => {
    const t = store.createTask({ title: 'x', status: 'running', assignee: 'r' });
    const run = store.startRun(t.id, 'r', 1, 'work');
    server.registerRun('wtok', { kind: 'task', taskId: t.id, runId: run.id, mode: 'work' }, 'L');
    const r = await rpc(`${base}?run=wtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'child' }
    });
    expect(String(r.error?.message ?? '')).toMatch(/unknown tool/i);
  });

  it('kanban_create makes a todo child linked to the orchestrator task', async () => {
    const parent = store.createTask({ title: 'big', status: 'running' });
    const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
    server.registerRun(
      'dtok2',
      { kind: 'task', taskId: parent.id, runId: run.id, mode: 'decompose' },
      'L'
    );
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
    server.registerRun(
      'btok',
      { kind: 'task', taskId: parent.id, runId: run.id, mode: 'decompose' },
      'L'
    );
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
    server.registerRun(
      'itok',
      { kind: 'task', taskId: parent.id, runId: run.id, mode: 'decompose' },
      'L'
    );
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
    server.registerRun(
      'itok2',
      { kind: 'task', taskId: parent.id, runId: run.id, mode: 'decompose' },
      'L'
    );
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
    server.registerRun(
      'itok3',
      { kind: 'task', taskId: parent.id, runId: run.id, mode: 'decompose' },
      'L'
    );
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
    server.registerRun(
      'dtok3',
      { kind: 'task', taskId: parent.id, runId: run.id, mode: 'decompose' },
      'L'
    );
    const r = await rpc(`${base}?run=dtok3`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'child', parents: [dep.id] }
    });
    const childId = String(r.result.content[0].text).trim();
    expect(store.parentsOf(childId).sort()).toEqual([dep.id, parent.id].sort());
  });

  // --- Spec-stage fan-out (full_feature pipeline) -------------------------------

  /** Expand a fresh full_feature root and return its laid-down stage ids. */
  function buildPipeline(): {
    featureId: string;
    specId: string;
    gateId: string;
    qaId: string;
  } {
    const root = store.createTask({
      title: 'Big feature',
      body: 'do a big thing',
      status: 'triage',
      pipelineTemplate: 'full_feature'
    });
    expandTemplate(root, FULL_FEATURE, store, { hasRole: () => true });
    const ev = store.listEvents(root.id).find((e) => e.kind === 'pipeline_expanded');
    const p = ev?.payload as Record<string, string>;
    return { featureId: p.featureId, specId: p.specId, gateId: p.gateId, qaId: p.qaId };
  }

  it('spec-stage kanban_create makes an implement child auto-linked to gate and qa', async () => {
    const { featureId, specId, gateId, qaId } = buildPipeline();
    const run = store.startRun(specId, 'architect', 1, 'spec');
    server.registerRun('spec1', { kind: 'task', taskId: specId, runId: run.id, mode: 'spec' }, 'L');

    const r = await rpc(`${base}?run=spec1`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'unit A', body: 'slice of the spec' }
    });
    const childId = String(r.result.content[0].text).trim();
    const child = store.getTask(childId);
    expect(child?.pipelineStage).toBe('implement');
    expect(child?.featureId).toBe(featureId);
    expect(store.parentsOf(childId)).toContain(gateId);
    expect(store.childrenOf(childId)).toContain(qaId);
    expect(store.listEvents(childId).some((e) => e.kind === 'task_created')).toBe(true);
    expect(store.listEvents(specId).filter((e) => e.kind === 'children_emitted')).toHaveLength(1);
  });

  it('spec-stage fan-out rejects a different run after children were emitted', async () => {
    const { specId, gateId } = buildPipeline();
    const run1 = store.startRun(specId, 'architect', 1, 'spec');
    server.registerRun(
      'specA',
      { kind: 'task', taskId: specId, runId: run1.id, mode: 'spec' },
      'L'
    );
    const first = await rpc(`${base}?run=specA`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'unit A' }
    });
    const firstChild = String(first.result.content[0].text).trim();
    expect(store.getTask(firstChild)).toBeTruthy();

    // A reclaim re-run is a DIFFERENT run on the same spec task.
    const run2 = store.startRun(specId, 'architect', 1, 'spec');
    server.registerRun(
      'specB',
      { kind: 'task', taskId: specId, runId: run2.id, mode: 'spec' },
      'L'
    );
    const second = await rpc(`${base}?run=specB`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'duplicate unit' }
    });
    expect(String(second.error?.message ?? '')).toMatch(/already emitted/i);
    // No duplicate fan-out: still exactly one children_emitted event and one implement child.
    expect(store.listEvents(specId).filter((e) => e.kind === 'children_emitted')).toHaveLength(1);
    const implementChildren = store
      .childrenOf(gateId)
      .filter((id) => store.getTask(id)?.pipelineStage === 'implement');
    expect(implementChildren).toHaveLength(1);
  });

  it('spec-stage fan-out caps at MAX_FANOUT children within one run', async () => {
    const { gateId, specId } = buildPipeline();
    const run = store.startRun(specId, 'architect', 1, 'spec');
    server.registerRun('specC', { kind: 'task', taskId: specId, runId: run.id, mode: 'spec' }, 'L');

    for (let i = 0; i < MAX_FANOUT; i++) {
      const r = await rpc(`${base}?run=specC`, 'tools/call', {
        name: 'kanban_create',
        arguments: { title: `unit ${i}` }
      });
      expect(r.error).toBeFalsy();
    }
    const r13 = await rpc(`${base}?run=specC`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'one too many' }
    });
    expect(String(r13.error?.message ?? '')).toMatch(/cap/i);
    const implementChildren = store
      .childrenOf(gateId)
      .filter((id) => store.getTask(id)?.pipelineStage === 'implement');
    expect(implementChildren).toHaveLength(MAX_FANOUT);
  });

  // --- QA-stage verdict (full_feature pipeline) ---------------------------------

  /** Promote the qa-stage task to running with a current run, mirroring the dispatcher. */
  function startQaRun(qaId: string, tok: string): void {
    store.returnToReady(qaId);
    store.claimTask(qaId, 'L', 15 * 60 * 1000);
    const run = store.startRun(qaId, 'qa', 1, 'qa');
    server.registerRun(tok, { kind: 'task', taskId: qaId, runId: run.id, mode: 'qa' }, 'L');
  }

  it('kanban_qa_verdict pass sets the feature verdict and completes the qa task', async () => {
    const { featureId, qaId } = buildPipeline();
    startQaRun(qaId, 'qaPass');

    const r = await rpc(`${base}?run=qaPass`, 'tools/call', {
      name: 'kanban_qa_verdict',
      arguments: { decision: 'pass', summary: 'all green end-to-end' }
    });
    expect(r.error).toBeFalsy();
    expect(store.getFeature(featureId)?.qaVerdict).toBe('pass');
    expect(store.getTask(qaId)?.status).toBe('done');
  });

  it('kanban_qa_verdict request_changes sets the verdict without completing the qa task', async () => {
    const { featureId, qaId } = buildPipeline();
    startQaRun(qaId, 'qaChanges');

    const r = await rpc(`${base}?run=qaChanges`, 'tools/call', {
      name: 'kanban_qa_verdict',
      arguments: { decision: 'request_changes', summary: 'login flow regressed' }
    });
    expect(r.error).toBeFalsy();
    expect(store.getFeature(featureId)?.qaVerdict).toBe('request_changes');
    expect(store.getTask(qaId)?.status).toBe('running');
  });

  it('kanban_update (specify) rewrites the body and returns the task to todo', async () => {
    const t = store.createTask({ title: 'vague', body: 'old', status: 'running' });
    const run = store.startRun(t.id, 'orchestrator', 1, 'specify');
    server.registerRun('stok', { kind: 'task', taskId: t.id, runId: run.id, mode: 'specify' }, 'L');
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
    server.registerRun(
      'toksw',
      { kind: 'task', taskId: workerId, runId: run.id, mode: 'work' },
      'LOCK'
    );

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
    server.registerRun(
      'tokres',
      { kind: 'task', taskId: workerId, runId: run.id, mode: 'work' },
      'LOCK'
    );
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
    server.registerRun(
      'tokorch',
      { kind: 'task', taskId: orch.id, runId: run.id, mode: 'decompose' },
      'LOCK'
    );

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

  it('kanban_create rejects an assignee that is not a known worker profile', async () => {
    const profiled = new KanbanMcpServer(store, () => [
      { name: 'default', role: 'worker' },
      { name: 'researcher', role: 'worker' },
      { name: 'orchestrator', role: 'orchestrator' }
    ]);
    const port = await profiled.start(0);
    try {
      const url = `http://127.0.0.1:${port}/mcp`;
      const parent = store.createTask({ title: 'big', status: 'running' });
      const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
      profiled.registerRun(
        'ptok',
        { kind: 'task', taskId: parent.id, runId: run.id, mode: 'decompose' },
        'L'
      );
      const r = await rpc(`${url}?run=ptok`, 'tools/call', {
        name: 'kanban_create',
        arguments: { title: 'child', assignee: 'backend-dev' }
      });
      expect(r.error).toBeTruthy();
      expect(String(r.error.message)).toMatch(/unknown worker profile "backend-dev"/i);
      expect(String(r.error.message)).toMatch(/default, researcher/);
      expect(store.listBoard().some((c) => c.title === 'child')).toBe(false);
    } finally {
      await profiled.stop();
    }
  });

  it('kanban_create rejects an orchestrator-role profile as an assignee', async () => {
    const profiled = new KanbanMcpServer(store, () => [
      { name: 'default', role: 'worker' },
      { name: 'orchestrator', role: 'orchestrator' }
    ]);
    const port = await profiled.start(0);
    try {
      const url = `http://127.0.0.1:${port}/mcp`;
      const parent = store.createTask({ title: 'big', status: 'running' });
      const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
      profiled.registerRun(
        'ptok2',
        { kind: 'task', taskId: parent.id, runId: run.id, mode: 'decompose' },
        'L'
      );
      const r = await rpc(`${url}?run=ptok2`, 'tools/call', {
        name: 'kanban_create',
        arguments: { title: 'child', assignee: 'orchestrator' }
      });
      expect(r.error).toBeTruthy();
      expect(String(r.error.message)).toMatch(/unknown worker profile "orchestrator"/i);
    } finally {
      await profiled.stop();
    }
  });

  it('kanban_create accepts a valid worker assignee when profiles are known', async () => {
    const profiled = new KanbanMcpServer(store, () => [{ name: 'researcher', role: 'worker' }]);
    const port = await profiled.start(0);
    try {
      const url = `http://127.0.0.1:${port}/mcp`;
      const parent = store.createTask({ title: 'big', status: 'running' });
      const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
      profiled.registerRun(
        'ptok3',
        { kind: 'task', taskId: parent.id, runId: run.id, mode: 'decompose' },
        'L'
      );
      const r = await rpc(`${url}?run=ptok3`, 'tools/call', {
        name: 'kanban_create',
        arguments: { title: 'child', assignee: 'researcher' }
      });
      const childId = String(r.result.content[0].text).trim();
      expect(store.getTask(childId)?.assignee).toBe('researcher');
    } finally {
      await profiled.stop();
    }
  });

  it('kanban_swarm_read rejects a non-swarm-root id', async () => {
    const plain = store.createTask({ title: 'plain', status: 'ready', assignee: 'r' });
    store.claimTask(plain.id, 'LOCK', 100000);
    const run = store.startRun(plain.id, 'r', 1);
    server.registerRun(
      'tokplain',
      { kind: 'task', taskId: plain.id, runId: run.id, mode: 'work' },
      'LOCK'
    );

    const r = await rpc(`${base}?run=tokplain`, 'tools/call', {
      name: 'kanban_swarm_read',
      arguments: { root: plain.id }
    });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/not a swarm root/i);
  });

  it('kanban_assign sets the assignee, returns to ready, and rejects unknown profiles', async () => {
    const profiles = () => [
      { name: 'alpha', role: 'worker' as const },
      { name: 'beta', role: 'worker' as const }
    ];
    const s2 = new KanbanMcpServer(store, profiles);
    const port2 = await s2.start(0);
    const base2 = `http://127.0.0.1:${port2}/mcp`;
    try {
      const t = store.createTask({ title: 'needs owner', status: 'ready' });
      store.claimForAssign(t.id, 'LOCK', 100000);
      const run = store.startRun(t.id, 'orchestrator', 1, 'assign');
      s2.registerRun('atok', { kind: 'task', taskId: t.id, runId: run.id, mode: 'assign' }, 'LOCK');

      const bad = await rpc(`${base2}?run=atok`, 'tools/call', {
        name: 'kanban_assign',
        arguments: { profile: 'ghost' }
      });
      expect(String(bad.error?.message ?? bad.result?.content?.[0]?.text)).toMatch(
        /unknown worker profile/i
      );
      expect(store.getTask(t.id)?.assignee).toBeNull();

      // Simulate a prior assign-phase failure so we can verify it's cleared on success.
      store.recordFailure(t.id, 'prior assign failure');

      const ok = await rpc(`${base2}?run=atok`, 'tools/call', {
        name: 'kanban_assign',
        arguments: { profile: 'alpha' }
      });
      expect(ok.result.content[0].text).toMatch(/alpha/i);
      const got = store.getTask(t.id);
      expect(got?.assignee).toBe('alpha');
      expect(got?.status).toBe('ready');
      expect(store.listRuns(t.id)[0].outcome).toBe('completed');
      // Assign-phase failures must not carry into the work phase's retry budget.
      expect(got?.consecutiveFailures).toBe(0);

      // Terminal: the run token must be unregistered after a successful assign.
      const after = await rpc(`${base2}?run=atok`, 'tools/call', {
        name: 'kanban_assign',
        arguments: { profile: 'alpha' }
      });
      expect(after.error).toBeTruthy();
      expect(String(after.error.message)).toMatch(/run token/i);
    } finally {
      await s2.stop();
    }
  });
});

describe('KanbanMcpServer board scope (PM chat)', () => {
  let store: KanbanStore;
  let server: KanbanMcpServer;
  let base: string;
  let commands: KanbanCommands;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(join(TEST_DIR, `pm-${Math.random().toString(36).slice(2)}.db`));
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
    commands = new KanbanCommands(store, dispatcher, () => ({
      workspaceKind: 'scratch',
      maxRuntimeSeconds: null
    }));
    server = new KanbanMcpServer(store);
    server.setCommands(commands);
    server.registerRun('pmtok', { kind: 'board', boardId: 'default' });
    const port = await server.start(0);
    base = `http://127.0.0.1:${port}/mcp`;
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('lists PM tools for a board token (no worker terminal tools)', async () => {
    const r = await rpc(`${base}?run=pmtok`, 'tools/list');
    const names = r.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('kanban_create');
    expect(names).toContain('kanban_set_status');
    expect(names).toContain('kanban_feature_create');
    expect(names).not.toContain('kanban_complete');
    expect(names).not.toContain('kanban_block');
    expect(names).not.toContain('kanban_swarm');
  });

  it('kanban_create makes a scratch todo task on the scoped board', async () => {
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'PM made this', body: 'spec', priority: 2 }
    });
    const id = String(r.result.content[0].text).trim();
    const task = store.getTask(id);
    expect(task?.title).toBe('PM made this');
    expect(task?.status).toBe('todo');
    expect(task?.priority).toBe(2);
    expect(task?.boardId).toBe('default');
    expect(task?.workspaceKind).toBe('scratch');
  });

  it('kanban_create carries a pipeline_template onto the created task', async () => {
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'templated', pipeline_template: 'full_feature' }
    });
    const id = String(r.result.content[0].text).trim();
    const task = store.getTask(id);
    expect(task?.pipelineTemplate).toBe('full_feature');
  });

  it('kanban_create links listed parents', async () => {
    const parent = store.createTask({ title: 'parent', status: 'todo' });
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'child', parents: [parent.id] }
    });
    const id = String(r.result.content[0].text).trim();
    expect(store.parentsOf(id)).toContain(parent.id);
  });

  it('kanban_set_status moves a task but refuses running tasks', async () => {
    const t = store.createTask({ title: 'm', status: 'todo' });
    const ok = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_set_status',
      arguments: { task_id: t.id, status: 'ready' }
    });
    expect(ok.error).toBeFalsy();
    expect(store.getTask(t.id)?.status).toBe('ready');

    const running = store.createTask({ title: 'r', status: 'running' });
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_set_status',
      arguments: { task_id: running.id, status: 'todo' }
    });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/running/i);
  });

  it('kanban_update edits title and priority of any board task', async () => {
    const t = store.createTask({ title: 'old', status: 'todo' });
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_update',
      arguments: { task_id: t.id, title: 'new', priority: 5 }
    });
    expect(r.error).toBeFalsy();
    const after = store.getTask(t.id);
    expect(after?.title).toBe('new');
    expect(after?.priority).toBe(5);
  });

  it('rejects tasks on a different board', async () => {
    const other = store.createBoard('Other Board');
    const t = store.createTask({ title: 'elsewhere', status: 'todo', boardId: other.slug });
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_set_status',
      arguments: { task_id: t.id, status: 'ready' }
    });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/not found on this board/i);
  });

  it('kanban_feature_create + kanban_create with feature_id inherit the feature repo', async () => {
    const f = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_feature_create',
      arguments: { name: 'Login flow', repo_path: '/tmp/some-repo', base_branch: 'main' }
    });
    const featureId = String(f.result.content[0].text).trim();
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'Add login form', feature_id: featureId }
    });
    const id = String(r.result.content[0].text).trim();
    const task = store.getTask(id);
    expect(task?.featureId).toBe(featureId);
    expect(task?.workspaceKind).toBe('worktree');
    expect(task?.repoPath).toBe('/tmp/some-repo');
  });

  it('worker tools are rejected on a board token', async () => {
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_complete',
      arguments: { summary: 'nope' }
    });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/unknown tool/i);
  });

  it('kanban_update refuses running tasks', async () => {
    const t = store.createTask({ title: 'busy', status: 'running' });
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_update',
      arguments: { task_id: t.id, title: 'hijacked' }
    });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/running/i);
    expect(store.getTask(t.id)?.title).toBe('busy');
  });

  it('kanban_project_add / list / remove manage the board registry', async () => {
    const add = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_project_add',
      arguments: { name: 'fleet', path: TEST_DIR, description: 'the app' }
    });
    expect(add.result.content[0].text).toMatch(/registered/i);
    const list = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_project_list',
      arguments: {}
    });
    expect(list.result.content[0].text).toContain('fleet');
    expect(list.result.content[0].text).toContain('(default)');
    const rm = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_project_remove',
      arguments: { name: 'fleet' }
    });
    expect(rm.result.content[0].text).toMatch(/removed/i);
    expect(store.listProjects('default')).toHaveLength(0);
  });

  it('kanban_create routes to the default project when project is omitted', async () => {
    store.addProject({ boardId: 'default', name: 'fleet', path: TEST_DIR });
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'routed' }
    });
    const t = store.getTask(r.result.content[0].text)!;
    expect(t.repoPath).toBe(TEST_DIR);
    expect(t.workspaceKind).toBe('worktree');
  });

  it('kanban_create with an explicit project name and rejects unknown names', async () => {
    store.addProject({ boardId: 'default', name: 'fleet', path: TEST_DIR });
    const bad = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'x', project: 'ghost' }
    });
    expect(String(bad.error.message)).toMatch(/unknown project/i);
    expect(String(bad.error.message)).toContain('fleet');
    const ok = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'x', project: 'fleet' }
    });
    expect(store.getTask(ok.result.content[0].text)!.repoPath).toBe(TEST_DIR);
  });

  it('kanban_create leaves zero-project boards scratch (no registry, no routing)', async () => {
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'plain' }
    });
    expect(store.getTask(r.result.content[0].text)!.workspaceKind).toBe('scratch');
  });

  it('feature repo wins over the default project and conflicting project is rejected', async () => {
    store.addProject({ boardId: 'default', name: 'fleet', path: TEST_DIR });
    const f = store.createFeature({ boardId: 'default', name: 'F', repoPath: '/elsewhere' });
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'member', feature_id: f.id }
    });
    expect(store.getTask(r.result.content[0].text)!.repoPath).toBe('/elsewhere');
    const bad = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'member2', feature_id: f.id, project: 'fleet' }
    });
    expect(String(bad.error.message)).toMatch(/conflicts/i);
  });

  it('kanban_feature_create accepts a project name for its repo', async () => {
    store.addProject({ boardId: 'default', name: 'fleet', path: TEST_DIR });
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_feature_create',
      arguments: { name: 'F2', project: 'fleet' }
    });
    expect(store.getFeature(r.result.content[0].text)!.repoPath).toBe(TEST_DIR);
  });

  it('kanban_create accepts docs that exist in the board docs dir and rejects others', async () => {
    const home = join(TEST_DIR, 'home');
    mkdirSync(join(home, 'pm', 'default', 'docs'), { recursive: true });
    writeFileSync(join(home, 'pm', 'default', 'docs', 'prd.md'), '# PRD');
    server.setKanbanHome(home);

    const bad = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'x', docs: ['missing.md'] }
    });
    expect(String(bad.error.message)).toMatch(/doc not found/i);

    const traversal = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'x', docs: ['../AGENTS.md'] }
    });
    expect(String(traversal.error.message)).toMatch(/invalid doc name/i);

    const ok = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'x', docs: ['prd.md'] }
    });
    expect(store.getTask(ok.result.content[0].text)!.docs).toEqual(['prd.md']);
  });

  it('kanban_update can set docs', async () => {
    const home = join(TEST_DIR, 'home2');
    mkdirSync(join(home, 'pm', 'default', 'docs'), { recursive: true });
    writeFileSync(join(home, 'pm', 'default', 'docs', 'spec.md'), '# spec');
    server.setKanbanHome(home);
    const t = store.createTask({ title: 'x' });

    const missing = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_update',
      arguments: { task_id: t.id, docs: ['missing.md'] }
    });
    expect(String(missing.error.message)).toMatch(/doc not found/i);

    const traversal = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_update',
      arguments: { task_id: t.id, docs: ['../AGENTS.md'] }
    });
    expect(String(traversal.error.message)).toMatch(/invalid doc name/i);

    // Identity is validated before docs: a nonexistent task wins even with valid docs.
    const ghost = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_update',
      arguments: { task_id: 'nope', docs: ['spec.md'] }
    });
    expect(String(ghost.error.message)).toMatch(/not found on this board/i);

    await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_update',
      arguments: { task_id: t.id, docs: ['spec.md'] }
    });
    expect(store.getTask(t.id)!.docs).toEqual(['spec.md']);

    const show = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_show',
      arguments: { task_id: t.id }
    });
    expect(show.result.content[0].text).toContain('docs: spec.md');
  });

  it('kanban_show lists kept artifacts and kanban_artifact_read returns text content', async () => {
    const t = store.createTask({ title: 'with art' });
    const ws = join(TEST_DIR, 'ws-art');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'report.md'), '# findings\nstuff');
    const art = store.addArtifact({
      taskId: t.id,
      runId: null,
      boardId: 'default',
      workspaceRoot: ws,
      relPath: 'report.md',
      kind: 'document'
    });

    const show = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_show',
      arguments: { task_id: t.id }
    });
    expect(show.result.content[0].text).toContain('## Artifacts');
    expect(show.result.content[0].text).toContain(art.id);

    const read = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_artifact_read',
      arguments: { artifact_id: art.id }
    });
    expect(read.result.content[0].text).toContain('# findings');

    store.discardArtifact(art.id);
    const after = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_show',
      arguments: { task_id: t.id }
    });
    expect(after.result.content[0].text).not.toContain('## Artifacts');
  });

  it('kanban_artifact_read rejects artifacts from other boards', async () => {
    const b = store.createBoard('Other');
    const t = store.createTask({ title: 'foreign', boardId: b.slug });
    const ws = join(TEST_DIR, 'ws-art2');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'x.md'), 'x');
    const art = store.addArtifact({
      taskId: t.id,
      runId: null,
      boardId: b.slug,
      workspaceRoot: ws,
      relPath: 'x.md'
    });
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_artifact_read',
      arguments: { artifact_id: art.id }
    });
    expect(String(r.error.message)).toMatch(/not found on this board/i);
  });

  it('auto-groups decompose children into a feature on kanban_complete', async () => {
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
    server.setCommands(commands);

    const parent = store.createTask({
      title: 'Group me',
      status: 'running',
      workspaceKind: 'worktree',
      repoPath: '/r',
      baseBranch: 'main'
    });
    const c1 = store.createTask({
      title: 'a',
      workspaceKind: 'worktree',
      repoPath: '/r',
      baseBranch: 'main'
    });
    const c2 = store.createTask({
      title: 'b',
      workspaceKind: 'worktree',
      repoPath: '/r',
      baseBranch: 'main'
    });
    store.addLink(parent.id, c1.id);
    store.addLink(parent.id, c2.id);
    const run = store.startRun(parent.id, 'orchestrator', null, 'decompose');
    server.registerRun('tok-dec', {
      kind: 'task',
      taskId: parent.id,
      runId: run.id,
      mode: 'decompose'
    });

    await rpc(`${base}?run=tok-dec`, 'tools/call', {
      name: 'kanban_complete',
      arguments: { summary: 'done' }
    });

    const features = store.listFeatures({});
    expect(features).toHaveLength(1);
    expect(store.getTask(c1.id)?.featureId).toBe(features[0].id);
  });

  it('suggest run records a pending suggestion and removes the system task', async () => {
    const sys = store.createTask({
      title: 'detect',
      status: 'running',
      boardId: 'default',
      systemKind: 'suggest',
      repoPath: '/r'
    });
    const t1 = store.createTask({
      title: 'a',
      boardId: 'default',
      workspaceKind: 'worktree',
      repoPath: '/r'
    });
    const t2 = store.createTask({
      title: 'b',
      boardId: 'default',
      workspaceKind: 'worktree',
      repoPath: '/r'
    });
    const run = store.startRun(sys.id, 'orchestrator', null, 'suggest');
    server.registerRun('tok-sug', { kind: 'task', taskId: sys.id, runId: run.id, mode: 'suggest' });

    await rpc(`${base}?run=tok-sug`, 'tools/call', {
      name: 'kanban_suggest_feature',
      arguments: { name: 'Grouped', task_ids: [t1.id, t2.id], reason: 'same area' }
    });

    const suggestions = store.listSuggestions('default');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].status).toBe('pending');
    expect(suggestions[0].taskIds).toEqual([t1.id, t2.id]);
    expect(suggestions[0].repoPath).toBe('/r');
    expect(store.getTask(sys.id)).toBeNull(); // system task gone
  });

  it('suggest run with no valid task_ids records no suggestion but still removes the system task', async () => {
    const sys = store.createTask({
      title: 'detect',
      status: 'running',
      boardId: 'default',
      systemKind: 'suggest',
      repoPath: '/r'
    });
    const run = store.startRun(sys.id, 'orchestrator', null, 'suggest');
    server.registerRun('tok-empty', {
      kind: 'task',
      taskId: sys.id,
      runId: run.id,
      mode: 'suggest'
    });

    await rpc(`${base}?run=tok-empty`, 'tools/call', {
      name: 'kanban_suggest_feature',
      arguments: { name: 'Grouped', task_ids: ['gone', 'also-gone'], reason: 'stale' }
    });

    expect(store.listSuggestions('default')).toHaveLength(0);
    expect(store.getTask(sys.id)).toBeNull();
  });

  it('suggest tools include kanban_suggest_feature', async () => {
    const sys = store.createTask({
      title: 'd',
      status: 'running',
      boardId: 'default',
      systemKind: 'suggest',
      repoPath: '/r'
    });
    const run = store.startRun(sys.id, 'orchestrator', null, 'suggest');
    server.registerRun('tok-list', {
      kind: 'task',
      taskId: sys.id,
      runId: run.id,
      mode: 'suggest'
    });
    const r = await rpc(`${base}?run=tok-list`, 'tools/list');
    const names = r.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('kanban_suggest_feature');
  });

  it('kanban_block on a suggest run deletes the system task instead of blocking it', async () => {
    const sys = store.createTask({
      title: 'd',
      status: 'running',
      boardId: 'default',
      systemKind: 'suggest',
      repoPath: '/r'
    });
    const run = store.startRun(sys.id, 'orchestrator', null, 'suggest');
    server.registerRun('tok-blk', { kind: 'task', taskId: sys.id, runId: run.id, mode: 'suggest' });
    await rpc(`${base}?run=tok-blk`, 'tools/call', {
      name: 'kanban_block',
      arguments: { reason: 'nothing related' }
    });
    expect(store.getTask(sys.id)).toBeNull();
  });
});

describe('KanbanMcpServer kanban_learning_create', () => {
  let store: KanbanStore;
  let learnings: LearningsStore;
  let server: KanbanMcpServer;
  let base: string;
  const dir = join(TEST_DIR, `learn-${Date.now()}`);

  beforeEach(async () => {
    mkdirSync(dir, { recursive: true });
    store = new KanbanStore(join(dir, 'mcp.db'));
    learnings = new LearningsStore(join(dir, 'learnings.db'));
    const dispatcher = new KanbanDispatcher(store, {
      now: () => 1,
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
    server = new KanbanMcpServer(store);
    server.setCommands(commands);
    server.setLearningsStore(learnings);
    server.registerRun('pmtok', { kind: 'board', boardId: 'default' });
    const port = await server.start(0);
    base = `http://127.0.0.1:${port}/mcp`;
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    learnings.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists kanban_learning_create for a board token', async () => {
    const r = await rpc(`${base}?run=pmtok`, 'tools/list');
    const names = r.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('kanban_learning_create');
  });

  it('writes a learning tagged retro', async () => {
    const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
      name: 'kanban_learning_create',
      arguments: {
        title: 'better-sqlite3 WAL needs busy_timeout',
        body: 'Set busy_timeout to avoid SQLITE_BUSY under concurrent writes.',
        tags: ['sqlite'],
        feature_id: 'f1'
      }
    });
    expect(String(r.result.content[0].text)).toMatch(/Learning saved/);
    const all = learnings.search({});
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('better-sqlite3 WAL needs busy_timeout');
    expect(all[0].tags).toContain('retro');
    expect(all[0].tags).toContain('sqlite');
    expect(all[0].sourceSessionId).toBe('f1');
  });

  it('rejects kanban_learning_create from a worker token', async () => {
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'L', 100000);
    const run = store.startRun(t.id, 'r', 1);
    server.registerRun('wtok', { kind: 'task', taskId: t.id, runId: run.id, mode: 'work' }, 'L');
    const r = await rpc(`${base}?run=wtok`, 'tools/call', {
      name: 'kanban_learning_create',
      arguments: { title: 'nope', body: 'nope' }
    });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/unknown tool/i);
  });
});
