import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { URL } from 'url';
import { z } from 'zod';
import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';
import type { RunMode, SwarmInput, SwarmCreated } from '../../shared/kanban-types';
import { latestBlackboard, postBlackboardUpdate, isSwarmRoot } from './kanban-swarm';

const log = createLogger('kanban-mcp');

interface RunScope {
  taskId: string;
  runId: number;
  mode: RunMode;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';

type McpTool = { name: string; description: string; inputSchema: Record<string, unknown> };

const WORKER_TOOLS: McpTool[] = [
  {
    name: 'kanban_show',
    description: 'Show the current task: title, body, comments, prior run summaries.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'kanban_complete',
    description: 'Mark the task done with a human-readable summary and optional metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        metadata: { type: 'object' }
      },
      required: ['summary']
    }
  },
  {
    name: 'kanban_block',
    description:
      'Block the task for human input. Prefix reason with "review-required: " for review.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason']
    }
  },
  {
    name: 'kanban_comment',
    description: 'Append a durable comment to the task thread.',
    inputSchema: {
      type: 'object',
      properties: { body: { type: 'string' } },
      required: ['body']
    }
  },
  {
    name: 'kanban_heartbeat',
    description: 'Signal liveness during a long operation; extends the claim lease.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string' } }
    }
  },
  {
    name: 'kanban_swarm_read',
    description: 'Read the merged shared blackboard of a swarm root (pass its id).',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' } },
      required: ['root']
    }
  },
  {
    name: 'kanban_swarm_post',
    description: 'Post a structured key/value fact to a swarm root blackboard (pass its id).',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, key: { type: 'string' }, value: {} },
      required: ['root', 'key', 'value']
    }
  },
  {
    name: 'kanban_artifact',
    description: 'Register an output file you produced as a durable task artifact.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' }, // relative to the task workspace
        title: { type: 'string' }, // optional display name
        kind: { type: 'string', enum: ['document', 'code', 'data', 'other'] }
      },
      required: ['path']
    }
  }
];

const ORCHESTRATOR_EXTRA_TOOLS: McpTool[] = [
  {
    name: 'kanban_list',
    description:
      'List board tasks. Optional filters by status and assignee (unknown assignee → empty).',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, assignee: { type: 'string' } }
    }
  },
  {
    name: 'kanban_create',
    description:
      'Create a child task (starts in todo, linked to the current task). Use parents for extra dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        assignee: { type: 'string' },
        priority: { type: 'number' },
        parents: { type: 'array', items: { type: 'string' } }
      },
      required: ['title']
    }
  },
  {
    name: 'kanban_link',
    description: 'Add a dependency link: child waits for parent to be done.',
    inputSchema: {
      type: 'object',
      properties: { parent_id: { type: 'string' }, child_id: { type: 'string' } },
      required: ['parent_id', 'child_id']
    }
  },
  {
    name: 'kanban_unblock',
    description: 'Return a blocked task to ready.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id']
    }
  },
  {
    name: 'kanban_swarm',
    description:
      'Create a swarm graph: N parallel workers, a verifier gated on all workers, ' +
      'and a synthesizer gated on the verifier. Inherits this task board.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        workers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              profile: { type: 'string' },
              title: { type: 'string' },
              skills: { type: 'array', items: { type: 'string' } }
            },
            required: ['profile', 'title']
          }
        },
        verifier: { type: 'string' },
        synthesizer: { type: 'string' }
      },
      required: ['goal', 'workers', 'verifier', 'synthesizer']
    }
  }
];

const DECOMPOSE_TOOLS: McpTool[] = [...WORKER_TOOLS, ...ORCHESTRATOR_EXTRA_TOOLS];

const SPECIFY_TOOLS: McpTool[] = [
  WORKER_TOOLS[0], // kanban_show
  {
    name: 'kanban_update',
    description: 'Rewrite this task with an improved title/body. Terminal — ends the specify run.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['body']
    }
  },
  ...WORKER_TOOLS.filter((t) => t.name === 'kanban_comment' || t.name === 'kanban_heartbeat')
];

function toolsForMode(mode: RunMode): McpTool[] {
  if (mode === 'decompose') return DECOMPOSE_TOOLS;
  if (mode === 'specify') return SPECIFY_TOOLS;
  return WORKER_TOOLS;
}

export class KanbanMcpServer {
  private server: Server | null = null;
  private runs = new Map<string, RunScope>();
  private claimLocks = new Map<string, string>(); // token -> claim lock (for heartbeat)

  private store: KanbanStore;
  private swarmHandler: ((input: SwarmInput) => SwarmCreated) | null = null;
  constructor(store: KanbanStore) {
    this.store = store;
  }

  /** Inject the swarm creation handler (KanbanCommands.createSwarm). */
  setSwarmHandler(handler: (input: SwarmInput) => SwarmCreated): void {
    this.swarmHandler = handler;
  }

  /** Register a per-run token; returns the token to embed in the worker's MCP url. */
  registerRun(token: string, scope: RunScope, claimLock: string): void {
    this.runs.set(token, scope);
    this.claimLocks.set(token, claimLock);
  }

  unregisterRun(token: string): void {
    this.runs.delete(token);
    this.claimLocks.delete(token);
  }

  start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          log.error('handler error', { error: err instanceof Error ? err.message : String(err) });
          this.send(res, 500, { error: 'internal' });
        });
      });
      this.server.on('error', reject);
      // Bind to loopback only — never expose the board to the network.
      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server?.address();
        const bound = typeof addr === 'object' && addr ? addr.port : port;
        log.info('kanban mcp server listening', { port: bound });
        resolve(bound);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json);
  }

  private rpcResult(res: ServerResponse, id: JsonRpcRequest['id'], result: unknown): void {
    this.send(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
  }

  private rpcError(res: ServerResponse, id: JsonRpcRequest['id'], message: string): void {
    this.send(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } });
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf-8');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return this.send(res, 405, { error: 'method not allowed' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = url.searchParams.get('run') ?? '';
    const raw = await this.readBody(req);
    let rpcReq: JsonRpcRequest;
    try {
      rpcReq = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return this.send(res, 400, { error: 'bad json' });
    }

    switch (rpcReq.method) {
      case 'initialize':
        return this.rpcResult(res, rpcReq.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'fleet-kanban', version: '1' }
        });
      case 'notifications/initialized':
        res.writeHead(202).end();
        return;
      case 'tools/list': {
        const scope = this.runs.get(token);
        return this.rpcResult(res, rpcReq.id, { tools: toolsForMode(scope?.mode ?? 'work') });
      }
      case 'tools/call':
        return this.handleToolCall(res, rpcReq, token);
      default:
        return this.rpcError(res, rpcReq.id, `unknown method: ${rpcReq.method}`);
    }
  }

  private text(res: ServerResponse, id: JsonRpcRequest['id'], message: string): void {
    this.rpcResult(res, id, { content: [{ type: 'text', text: message }] });
  }

  private handleToolCall(res: ServerResponse, rpcReq: JsonRpcRequest, token: string): void {
    const scope = this.runs.get(token);
    if (!scope) return this.rpcError(res, rpcReq.id, 'unknown or missing run token');

    const params = rpcReq.params ?? {};
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const task = this.store.getTask(scope.taskId);
    if (!task) return this.rpcError(res, rpcReq.id, `task ${scope.taskId} not found`);
    const author = task.assignee ?? 'worker';

    const allowed = toolsForMode(scope.mode).some((t) => t.name === name);
    if (!allowed) return this.rpcError(res, rpcReq.id, `unknown tool: ${name}`);

    try {
      switch (name) {
        case 'kanban_show': {
          const comments = this.store.listComments(task.id);
          const runs = this.store.listRuns(task.id).filter((r) => r.summary);
          const lines = [
            `# ${task.title} (${task.id})`,
            '',
            task.body || '(no body)',
            '',
            comments.length ? '## Comments' : '',
            ...comments.map((c) => `- ${c.author}: ${c.body}`),
            runs.length ? '## Prior runs' : '',
            ...runs.map((r) => `- ${r.outcome}: ${r.summary ?? ''}`)
          ].filter(Boolean);
          return this.text(res, rpcReq.id, lines.join('\n'));
        }
        case 'kanban_complete': {
          const a = z
            .object({ summary: z.string(), metadata: z.record(z.string(), z.unknown()).optional() })
            .parse(args);
          this.store.completeTask(task.id, a.summary);
          this.store.finishRun(scope.runId, 'completed', {
            summary: a.summary,
            metadata: a.metadata
          });
          this.store.appendEvent(task.id, scope.runId, 'completed', { summary: a.summary });
          this.unregisterRun(token);
          return this.text(res, rpcReq.id, `Task ${task.id} marked done.`);
        }
        case 'kanban_block': {
          const a = z.object({ reason: z.string() }).parse(args);
          this.store.blockTask(task.id, a.reason);
          this.store.finishRun(scope.runId, 'blocked', { summary: a.reason });
          this.store.appendEvent(task.id, scope.runId, 'blocked', { reason: a.reason });
          this.unregisterRun(token);
          return this.text(res, rpcReq.id, `Task ${task.id} blocked.`);
        }
        case 'kanban_comment': {
          const a = z.object({ body: z.string() }).parse(args);
          this.store.addComment(task.id, author, a.body);
          this.store.appendEvent(task.id, scope.runId, 'comment', { author });
          return this.text(res, rpcReq.id, 'Comment added.');
        }
        case 'kanban_swarm_read': {
          const a = z.object({ root: z.string() }).parse(args);
          if (!isSwarmRoot(this.store, a.root)) {
            return this.rpcError(res, rpcReq.id, `${a.root} is not a swarm root`);
          }
          return this.text(res, rpcReq.id, JSON.stringify(latestBlackboard(this.store, a.root)));
        }
        case 'kanban_swarm_post': {
          const a = z
            .object({ root: z.string(), key: z.string(), value: z.unknown() })
            .parse(args);
          if (!isSwarmRoot(this.store, a.root)) {
            return this.rpcError(res, rpcReq.id, `${a.root} is not a swarm root`);
          }
          if (a.key === '_authors') {
            return this.rpcError(res, rpcReq.id, '"_authors" is a reserved blackboard key');
          }
          postBlackboardUpdate(this.store, a.root, author, a.key, a.value);
          this.store.appendEvent(a.root, null, 'blackboard_post', { author, key: a.key });
          return this.text(res, rpcReq.id, 'Blackboard updated.');
        }
        case 'kanban_artifact': {
          const a = z
            .object({
              path: z.string(),
              title: z.string().optional(),
              kind: z.enum(['document', 'code', 'data', 'other']).optional()
            })
            .parse(args);
          if (!task.workspacePath) {
            return this.rpcError(res, rpcReq.id, 'workspace not ready');
          }
          const artifact = this.store.addArtifact({
            taskId: task.id,
            runId: scope.runId,
            boardId: task.boardId,
            workspaceRoot: task.workspacePath,
            relPath: a.path,
            title: a.title ?? null,
            kind: a.kind
          });
          this.store.appendEvent(task.id, scope.runId, 'artifact_added', {
            id: artifact.id,
            filename: artifact.filename
          });
          return this.text(res, rpcReq.id, artifact.id);
        }
        case 'kanban_heartbeat': {
          const lock = this.claimLocks.get(token);
          if (lock) this.store.extendClaim(task.id, lock, 15 * 60 * 1000);
          this.store.appendEvent(task.id, scope.runId, 'heartbeat', {});
          return this.text(res, rpcReq.id, 'Heartbeat recorded.');
        }
        case 'kanban_list': {
          const a = z
            .object({ status: z.string().optional(), assignee: z.string().optional() })
            .parse(args);
          let rows = this.store.listBoard();
          if (a.status) rows = rows.filter((c) => c.status === a.status);
          if (a.assignee) rows = rows.filter((c) => c.assignee === a.assignee);
          const lines = rows.map((c) => `${c.id}\t${c.status}\t${c.assignee ?? '-'}\t${c.title}`);
          return this.text(res, rpcReq.id, lines.join('\n') || '(no tasks)');
        }
        case 'kanban_create': {
          const a = z
            .object({
              title: z.string(),
              body: z.string().optional(),
              assignee: z.string().optional(),
              priority: z.number().optional(),
              parents: z.array(z.string()).optional()
            })
            .parse(args);
          // Children of a worktree parent inherit its source repo so each runs
          // in its own kanban/<childId> worktree. Gate on a truthy repoPath:
          // store.createTask bypasses the create() repoPath guard, so a
          // worktree task without a repo would fail at claim time.
          const inherit =
            task.workspaceKind === 'worktree' && task.repoPath
              ? { workspaceKind: 'worktree' as const, repoPath: task.repoPath }
              : {};
          const child = this.store.createTask({
            title: a.title,
            body: a.body ?? '',
            assignee: a.assignee ?? null,
            priority: a.priority ?? 0,
            status: 'todo',
            boardId: task.boardId,
            ...inherit
          });
          this.store.addLink(scope.taskId, child.id); // original is the grouping parent
          for (const p of a.parents ?? []) this.store.addLink(p, child.id);
          this.store.appendEvent(child.id, scope.runId, 'task_created', {
            by: 'orchestrator',
            parent: scope.taskId
          });
          return this.text(res, rpcReq.id, child.id);
        }
        case 'kanban_link': {
          const a = z.object({ parent_id: z.string(), child_id: z.string() }).parse(args);
          this.store.addLink(a.parent_id, a.child_id);
          this.store.appendEvent(a.child_id, scope.runId, 'link_added', { parentId: a.parent_id });
          return this.text(res, rpcReq.id, 'Linked.');
        }
        case 'kanban_unblock': {
          const a = z.object({ task_id: z.string() }).parse(args);
          this.store.setStatus(a.task_id, 'ready');
          this.store.appendEvent(a.task_id, scope.runId, 'status_changed', {
            to: 'ready',
            by: 'orchestrator'
          });
          return this.text(res, rpcReq.id, 'Unblocked.');
        }
        case 'kanban_swarm': {
          if (!this.swarmHandler) {
            return this.rpcError(res, rpcReq.id, 'swarm creation is not available');
          }
          const a = z
            .object({
              goal: z.string(),
              workers: z
                .array(
                  z.object({
                    profile: z.string(),
                    title: z.string(),
                    skills: z.array(z.string()).optional()
                  })
                )
                .min(1),
              verifier: z.string(),
              synthesizer: z.string()
            })
            .parse(args);
          const inheritRepo =
            task.workspaceKind === 'worktree' && task.repoPath
              ? { workspaceKind: 'worktree' as const, repoPath: task.repoPath }
              : {};
          const created = this.swarmHandler({
            goal: a.goal,
            workers: a.workers.map((w) => ({
              profile: w.profile,
              title: w.title,
              skills: w.skills ?? []
            })),
            verifierAssignee: a.verifier,
            synthesizerAssignee: a.synthesizer,
            boardId: task.boardId,
            createdBy: author,
            ...inheritRepo
          });
          return this.text(res, rpcReq.id, JSON.stringify(created));
        }
        case 'kanban_update': {
          const a = z.object({ title: z.string().optional(), body: z.string() }).parse(args);
          this.store.updateTask(task.id, { title: a.title, body: a.body });
          this.store.appendEvent(task.id, scope.runId, 'task_updated', { by: 'orchestrator' });
          this.store.setStatusCleared(task.id, 'todo');
          this.store.finishRun(scope.runId, 'completed', { summary: 'specified' });
          this.unregisterRun(token);
          return this.text(res, rpcReq.id, `Task ${task.id} specified.`);
        }
        default:
          return this.rpcError(res, rpcReq.id, `unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.rpcError(res, rpcReq.id, msg);
    }
  }
}
