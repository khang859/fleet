import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { URL } from 'url';
import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';
import type { KanbanCommands } from './kanban-commands';
import type {
  CreateTaskInput,
  RunMode,
  SwarmInput,
  SwarmCreated,
  Task
} from '../../shared/kanban-types';
import type { WorkerProfile } from '../../shared/types';
import { latestBlackboard, postBlackboardUpdate, isSwarmRoot } from './kanban-swarm';
import { finalizeWorktree, reviewStat, checkMergeConflicts } from './workspace';
import { pmDocsDir } from './pm-paths';

const log = createLogger('kanban-mcp');

/** A worker/orchestrator run bound to one task. */
interface TaskScope {
  kind: 'task';
  taskId: string;
  runId: number;
  mode: RunMode;
}

/** A PM chat turn scoped to a whole board — no task, no run, no claim. */
interface BoardScope {
  kind: 'board';
  boardId: string;
}

export type RunScope = TaskScope | BoardScope;

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
        parents: { type: 'array', items: { type: 'string' } },
        feature_id: { type: 'string' } // defaults to the current task's feature
      },
      required: ['title']
    }
  },
  {
    name: 'kanban_feature_create',
    description:
      'Create a feature (task grouping) on this board. Returns its id; pass to kanban_create as feature_id to group the tasks you create.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        base_branch: { type: 'string' }
      },
      required: ['name']
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

/** Statuses the PM may set — mirrors MANUAL_STATUSES (dispatcher owns `running`). */
const PM_SETTABLE_STATUSES = [
  'triage',
  'todo',
  'ready',
  'blocked',
  'review',
  'done',
  'archived'
] as const;

/**
 * Board-scoped tools for the PM chat. Unlike worker tools there is no implicit
 * "current task" — every task-touching tool takes an explicit task_id. Mutations
 * route through KanbanCommands so the PM obeys the same validation as the UI
 * (running tasks are dispatcher-owned, review is worktree-only, etc.).
 */
const PM_TOOLS: McpTool[] = [
  {
    name: 'kanban_list',
    description: 'List the board tasks. Optional filters by status and assignee.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, assignee: { type: 'string' } }
    }
  },
  {
    name: 'kanban_show',
    description: 'Show one task by id: title, body, status, comments, prior run summaries.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id']
    }
  },
  {
    name: 'kanban_create',
    description:
      'Create a task on the board. Status defaults to todo (use triage for ideas needing ' +
      'refinement). Pass feature_id to group it under a feature, parents for dependencies.' +
      ' Pass project (a registered project name) to route the ticket to that repo; omitted, the board default project applies.' +
      ' Pass docs (filenames in your docs/ folder) to show those documents to the executing worker.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        assignee: { type: 'string' },
        priority: { type: 'number' },
        status: { type: 'string', enum: ['triage', 'todo', 'ready', 'blocked'] },
        parents: { type: 'array', items: { type: 'string' } },
        feature_id: { type: 'string' },
        project: { type: 'string' },
        docs: { type: 'array', items: { type: 'string' } }
      },
      required: ['title']
    }
  },
  {
    name: 'kanban_update',
    description: 'Update a task by id: title, body, priority, and/or assignee.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        priority: { type: 'number' },
        assignee: { type: 'string' },
        docs: { type: 'array', items: { type: 'string' } }
      },
      required: ['task_id']
    }
  },
  {
    name: 'kanban_set_status',
    description:
      'Move a task to a new status (triage/todo/ready/blocked/review/done/archived). ' +
      'Running tasks are dispatcher-owned and cannot be moved.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', enum: [...PM_SETTABLE_STATUSES] }
      },
      required: ['task_id', 'status']
    }
  },
  {
    name: 'kanban_comment',
    description: 'Append a durable comment to a task thread.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, body: { type: 'string' } },
      required: ['task_id', 'body']
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
    name: 'kanban_feature_create',
    description:
      'Create a feature (task grouping) on this board. Returns its id; pass it to ' +
      'kanban_create as feature_id to group tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        repo_path: { type: 'string' },
        base_branch: { type: 'string' },
        project: { type: 'string' }
      },
      required: ['name']
    }
  },
  {
    name: 'kanban_assign_feature',
    description: 'Set or clear (pass null) a task feature membership.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        feature_id: { type: ['string', 'null'] }
      },
      required: ['task_id', 'feature_id']
    }
  },
  {
    name: 'kanban_project_list',
    description: 'List this board registered project folders (name, path, description, default).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'kanban_project_add',
    description:
      'Register a project folder on this board. The first project becomes the default; ' +
      'tickets route to the default unless another project is named.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        path: { type: 'string' }, // absolute folder path
        description: { type: 'string' }
      },
      required: ['name', 'path']
    }
  },
  {
    name: 'kanban_project_remove',
    description: 'Remove a registered project by name. Existing tickets keep their repo path.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }
  }
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
  private commands: KanbanCommands | null = null;
  private kanbanHome: string | null = null;
  private getProfiles: () => Array<Pick<WorkerProfile, 'name' | 'role'>>;
  constructor(
    store: KanbanStore,
    getProfiles: () => Array<Pick<WorkerProfile, 'name' | 'role'>> = () => []
  ) {
    this.store = store;
    this.getProfiles = getProfiles;
  }

  /** Inject the swarm creation handler (KanbanCommands.createSwarm). */
  setSwarmHandler(handler: (input: SwarmInput) => SwarmCreated): void {
    this.swarmHandler = handler;
  }

  /** Inject the command layer; PM (board-scoped) tools route through it for validation. */
  setCommands(commands: KanbanCommands): void {
    this.commands = commands;
  }

  /** Inject the kanban home so PM doc references can be validated against pm/<board>/docs. */
  setKanbanHome(home: string): void {
    this.kanbanHome = home;
  }

  /** Returns an error message, or null when every doc name is safe and present. */
  private validateDocs(boardId: string, docs: string[]): string | null {
    if (!this.kanbanHome) return 'board docs are unavailable';
    for (const name of docs) {
      if (name.startsWith('/') || name.includes('..')) return `invalid doc name: ${name}`;
      if (!existsSync(join(pmDocsDir(this.kanbanHome, boardId), name))) {
        return `doc not found in the board docs folder: ${name}`;
      }
    }
    return null;
  }

  /** Register a per-run token; returns the token to embed in the worker's MCP url. */
  registerRun(token: string, scope: RunScope, claimLock?: string): void {
    this.runs.set(token, scope);
    if (claimLock) this.claimLocks.set(token, claimLock);
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
        if (scope?.kind === 'board') return this.rpcResult(res, rpcReq.id, { tools: PM_TOOLS });
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

  /**
   * Workspace fields a child / swarm worker inherits from its parent task: a
   * worktree parent gives each child its own worktree branched from the parent's
   * base (so it inherits merged work); a 'dir' parent shares its folder. Without
   * this a child falls back to an empty scratch sandbox.
   */
  private inheritWorkspace(task: Task): {
    workspaceKind?: 'worktree' | 'dir';
    repoPath?: string;
    baseBranch?: string | null;
    workspacePath?: string;
    featureId?: string | null;
  } {
    // Children inherit feature membership so a decompose run keeps the whole group together.
    const feature = task.featureId ? { featureId: task.featureId } : {};
    if (task.workspaceKind === 'worktree' && task.repoPath) {
      return {
        workspaceKind: 'worktree',
        repoPath: task.repoPath,
        baseBranch: task.baseBranch,
        ...feature
      };
    }
    if (task.workspaceKind === 'dir' && task.workspacePath) {
      return { workspaceKind: 'dir', workspacePath: task.workspacePath, ...feature };
    }
    return { ...feature };
  }

  /** A task resolved by id, only if it lives on the PM scope's board. */
  private pmTask(scope: BoardScope, id: string): Task | null {
    const t = this.store.getTask(id);
    return t && t.boardId === scope.boardId ? t : null;
  }

  /** Board-scoped (PM chat) tool dispatch. Mutations route through KanbanCommands. */
  private handlePmToolCall(
    res: ServerResponse,
    rpcReq: JsonRpcRequest,
    scope: BoardScope,
    name: string,
    args: Record<string, unknown>
  ): void {
    const commands = this.commands;
    if (!commands) return this.rpcError(res, rpcReq.id, 'kanban commands are not available');
    if (!PM_TOOLS.some((t) => t.name === name)) {
      return this.rpcError(res, rpcReq.id, `unknown tool: ${name}`);
    }
    try {
      switch (name) {
        case 'kanban_list': {
          const a = z
            .object({ status: z.string().optional(), assignee: z.string().optional() })
            .parse(args);
          let rows = this.store.listBoard(scope.boardId);
          if (a.status) rows = rows.filter((c) => c.status === a.status);
          if (a.assignee) rows = rows.filter((c) => c.assignee === a.assignee);
          const lines = rows.map(
            (c) => `${c.id}\t${c.status}\tp${c.priority}\t${c.assignee ?? '-'}\t${c.title}`
          );
          return this.text(res, rpcReq.id, lines.join('\n') || '(no tasks)');
        }
        case 'kanban_show': {
          const a = z.object({ task_id: z.string() }).parse(args);
          const detail = commands.show(a.task_id);
          if (!detail || detail.task.boardId !== scope.boardId) {
            return this.rpcError(res, rpcReq.id, `task not found on this board: ${a.task_id}`);
          }
          const { task, comments, runs } = detail;
          const summaries = runs.filter((r) => r.summary);
          const lines = [
            `# ${task.title} (${task.id})`,
            `status: ${task.status}  priority: ${task.priority}  assignee: ${task.assignee ?? '-'}`,
            task.featureId ? `feature: ${task.featureId}` : '',
            '',
            task.body || '(no body)',
            comments.length ? '## Comments' : '',
            ...comments.map((c) => `- ${c.author}: ${c.body}`),
            summaries.length ? '## Prior runs' : '',
            ...summaries.map((r) => `- ${r.outcome}: ${r.summary ?? ''}`)
          ].filter(Boolean);
          return this.text(res, rpcReq.id, lines.join('\n'));
        }
        case 'kanban_create': {
          const a = z
            .object({
              title: z.string(),
              body: z.string().optional(),
              assignee: z.string().optional(),
              priority: z.number().optional(),
              status: z.enum(['triage', 'todo', 'ready', 'blocked']).optional(),
              parents: z.array(z.string()).optional(),
              feature_id: z.string().optional(),
              project: z.string().optional(),
              docs: z.array(z.string()).optional()
            })
            .parse(args);
          if (a.docs && a.docs.length > 0) {
            const docErr = this.validateDocs(scope.boardId, a.docs);
            if (docErr) return this.rpcError(res, rpcReq.id, docErr);
          }
          // Same phantom-assignee guard as the orchestrator's kanban_create.
          const assignee = a.assignee?.trim() || null;
          const workerNames = this.getProfiles()
            .filter((p) => p.role === 'worker')
            .map((p) => p.name);
          if (assignee && workerNames.length > 0 && !workerNames.includes(assignee)) {
            return this.rpcError(
              res,
              rpcReq.id,
              `unknown worker profile "${assignee}". Valid profiles: ${workerNames.join(', ')}`
            );
          }
          // Workspace routing precedence: feature repo (keeps the group integrable) >
          // explicit project > board default project > scratch.
          let workspace: Partial<
            Pick<CreateTaskInput, 'workspaceKind' | 'repoPath' | 'baseBranch'>
          > = { workspaceKind: 'scratch' };
          let featureRepo: string | null = null;
          if (a.feature_id) {
            const feature = this.store.getFeature(a.feature_id);
            if (!feature || feature.boardId !== scope.boardId) {
              return this.rpcError(
                res,
                rpcReq.id,
                `feature not found on this board: ${a.feature_id}`
              );
            }
            if (feature.repoPath) {
              featureRepo = feature.repoPath;
              workspace = {
                workspaceKind: 'worktree',
                repoPath: feature.repoPath,
                baseBranch: feature.baseBranch
              };
            }
          }
          const projects = this.store.listProjects(scope.boardId);
          let proj =
            a.project !== undefined ? (projects.find((p) => p.name === a.project) ?? null) : null;
          if (a.project !== undefined && !proj) {
            const names = projects.map((p) => p.name).join(', ') || '(none registered)';
            return this.rpcError(
              res,
              rpcReq.id,
              `unknown project "${a.project}". Registered: ${names}`
            );
          }
          if (proj && featureRepo && proj.path !== featureRepo) {
            return this.rpcError(
              res,
              rpcReq.id,
              `project "${proj.name}" conflicts with the feature repo (${featureRepo}); omit project or match it`
            );
          }
          if (!proj && !featureRepo) proj = projects.find((p) => p.isDefault) ?? null;
          if (proj && !featureRepo) {
            workspace = { workspaceKind: 'worktree', repoPath: proj.path };
          }
          for (const p of a.parents ?? []) {
            if (!this.pmTask(scope, p)) {
              return this.rpcError(res, rpcReq.id, `parent task not found on this board: ${p}`);
            }
          }
          const task = commands.create({
            title: a.title,
            body: a.body ?? '',
            assignee,
            priority: a.priority ?? 0,
            status: a.status ?? 'todo',
            boardId: scope.boardId,
            featureId: a.feature_id ?? null,
            docs: a.docs ?? [],
            ...workspace
          });
          for (const p of a.parents ?? []) commands.link(p, task.id);
          return this.text(res, rpcReq.id, task.id);
        }
        case 'kanban_update': {
          const a = z
            .object({
              task_id: z.string(),
              title: z.string().optional(),
              body: z.string().optional(),
              priority: z.number().optional(),
              assignee: z.string().optional(),
              docs: z.array(z.string()).optional()
            })
            .parse(args);
          const existing = this.pmTask(scope, a.task_id);
          if (!existing) {
            return this.rpcError(res, rpcReq.id, `task not found on this board: ${a.task_id}`);
          }
          // A running worker reads its task via kanban_show mid-turn; editing it
          // out from under the worker is dispatcher territory, same as status.
          if (existing.status === 'running') {
            return this.rpcError(res, rpcReq.id, 'cannot update a running task');
          }
          if (a.docs && a.docs.length > 0) {
            const docErr = this.validateDocs(scope.boardId, a.docs);
            if (docErr) return this.rpcError(res, rpcReq.id, docErr);
          }
          commands.update(a.task_id, {
            title: a.title,
            body: a.body,
            priority: a.priority,
            ...(a.assignee !== undefined ? { assignee: a.assignee.trim() || null } : {}),
            ...(a.docs !== undefined ? { docs: a.docs } : {})
          });
          return this.text(res, rpcReq.id, 'Task updated.');
        }
        case 'kanban_set_status': {
          const a = z
            .object({ task_id: z.string(), status: z.enum(PM_SETTABLE_STATUSES) })
            .parse(args);
          if (!this.pmTask(scope, a.task_id)) {
            return this.rpcError(res, rpcReq.id, `task not found on this board: ${a.task_id}`);
          }
          commands.setManualStatus(a.task_id, a.status);
          return this.text(res, rpcReq.id, `Task ${a.task_id} moved to ${a.status}.`);
        }
        case 'kanban_comment': {
          const a = z.object({ task_id: z.string(), body: z.string() }).parse(args);
          if (!this.pmTask(scope, a.task_id)) {
            return this.rpcError(res, rpcReq.id, `task not found on this board: ${a.task_id}`);
          }
          this.store.addComment(a.task_id, 'pm', a.body);
          this.store.appendEvent(a.task_id, null, 'comment_added', { author: 'pm' });
          return this.text(res, rpcReq.id, 'Comment added.');
        }
        case 'kanban_link': {
          const a = z.object({ parent_id: z.string(), child_id: z.string() }).parse(args);
          if (!this.pmTask(scope, a.parent_id) || !this.pmTask(scope, a.child_id)) {
            return this.rpcError(res, rpcReq.id, 'both tasks must exist on this board');
          }
          commands.link(a.parent_id, a.child_id);
          return this.text(res, rpcReq.id, 'Linked.');
        }
        case 'kanban_feature_create': {
          const a = z
            .object({
              name: z.string(),
              repo_path: z.string().optional(),
              base_branch: z.string().optional(),
              project: z.string().optional()
            })
            .parse(args);
          let repoPath = a.repo_path ?? null;
          if (a.project !== undefined) {
            if (repoPath) return this.rpcError(res, rpcReq.id, 'pass either project or repo_path, not both');
            const p = this.store.getProjectByName(scope.boardId, a.project);
            if (!p) return this.rpcError(res, rpcReq.id, `unknown project: ${a.project}`);
            repoPath = p.path;
          }
          const feature = commands.createFeature({
            boardId: scope.boardId,
            name: a.name,
            repoPath,
            baseBranch: a.base_branch ?? null
          });
          return this.text(res, rpcReq.id, feature.id);
        }
        case 'kanban_assign_feature': {
          const a = z
            .object({ task_id: z.string(), feature_id: z.union([z.string(), z.null()]) })
            .parse(args);
          if (!this.pmTask(scope, a.task_id)) {
            return this.rpcError(res, rpcReq.id, `task not found on this board: ${a.task_id}`);
          }
          commands.assignTaskToFeature(a.task_id, a.feature_id);
          return this.text(res, rpcReq.id, 'Feature membership updated.');
        }
        case 'kanban_project_list': {
          const projects = this.store.listProjects(scope.boardId);
          const lines = projects.map((p) => {
            const desc = p.description ? ` — ${p.description}` : '';
            return `- ${p.name} → ${p.path}${desc}${p.isDefault ? ' (default)' : ''}`;
          });
          return this.text(res, rpcReq.id, lines.join('\n') || '(no projects registered)');
        }
        case 'kanban_project_add': {
          const a = z
            .object({ name: z.string(), path: z.string(), description: z.string().optional() })
            .parse(args);
          const p = commands.addProject({
            boardId: scope.boardId,
            name: a.name,
            path: a.path,
            description: a.description ?? null
          });
          return this.text(
            res,
            rpcReq.id,
            `Project "${p.name}" registered${p.isDefault ? ' as the default' : ''}.`
          );
        }
        case 'kanban_project_remove': {
          const a = z.object({ name: z.string() }).parse(args);
          const p = this.store.getProjectByName(scope.boardId, a.name);
          if (!p) return this.rpcError(res, rpcReq.id, `project not found on this board: ${a.name}`);
          commands.removeProject(p.id);
          return this.text(res, rpcReq.id, `Project "${a.name}" removed.`);
        }
        default:
          return this.rpcError(res, rpcReq.id, `unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.rpcError(res, rpcReq.id, msg);
    }
  }

  private handleToolCall(res: ServerResponse, rpcReq: JsonRpcRequest, token: string): void {
    const scope = this.runs.get(token);
    if (!scope) return this.rpcError(res, rpcReq.id, 'unknown or missing run token');

    const params = rpcReq.params ?? {};
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (scope.kind === 'board') return this.handlePmToolCall(res, rpcReq, scope, name, args);
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
          // Worktree tasks don't go straight to done: commit the work, land it in
          // the human review gate, and record what changed. Scratch/dir tasks have
          // nothing to merge, so they complete as before.
          if (task.workspaceKind === 'worktree' && task.workspacePath) {
            finalizeWorktree({
              workspacePath: task.workspacePath,
              taskId: task.id,
              title: task.title
            });
            const stat = reviewStat({
              workspacePath: task.workspacePath,
              baseBranch: task.baseBranch
            });
            this.store.reviewTask(task.id, a.summary);
            // Pre-compute whether this will merge cleanly into its base (the feature
            // integration branch, for feature tasks) so the board can warn up-front.
            if (task.repoPath && task.branchName && task.baseBranch) {
              const c = checkMergeConflicts({
                repoPath: task.repoPath,
                baseBranch: task.baseBranch,
                branchName: task.branchName
              });
              this.store.setTaskConflict(task.id, c.state, c.files);
            }
            this.store.finishRun(scope.runId, 'completed', {
              summary: a.summary,
              metadata: { ...a.metadata, review: stat ?? undefined }
            });
            this.store.appendEvent(task.id, scope.runId, 'completed', { summary: a.summary });
            const where = task.branchName ?? `kanban/${task.id}`;
            const statText = stat
              ? `${stat.files} file${stat.files === 1 ? '' : 's'} (+${stat.insertions}/−${stat.deletions})`
              : 'changes committed';
            this.store.addComment(task.id, author, `review-required: ${statText} on ${where}`);
            this.unregisterRun(token);
            return this.text(res, rpcReq.id, `Task ${task.id} ready for review.`);
          }
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
              parents: z.array(z.string()).optional(),
              feature_id: z.string().optional()
            })
            .parse(args);
          // The orchestrator must assign children only to worker profiles that actually
          // exist — otherwise the card shows a phantom assignee and the work run silently
          // falls back to a different profile. Reject unknown names so the model retries
          // with a real one (mirrors createSwarm's worker-profile guard). Skip when no
          // profiles are known (tests/fresh state) — there's nothing to validate against.
          const assignee = a.assignee?.trim() || null;
          const workerNames = this.getProfiles()
            .filter((p) => p.role === 'worker')
            .map((p) => p.name);
          if (assignee && workerNames.length > 0 && !workerNames.includes(assignee)) {
            return this.rpcError(
              res,
              rpcReq.id,
              `unknown worker profile "${assignee}". Valid profiles: ${workerNames.join(', ')}`
            );
          }
          const inherit = this.inheritWorkspace(task);
          const child = this.store.createTask({
            title: a.title,
            body: a.body ?? '',
            assignee,
            priority: a.priority ?? 0,
            status: 'todo',
            boardId: task.boardId,
            ...inherit,
            // An explicit feature_id overrides the inherited one.
            ...(a.feature_id ? { featureId: a.feature_id } : {})
          });
          this.store.addLink(scope.taskId, child.id); // original is the grouping parent
          for (const p of a.parents ?? []) this.store.addLink(p, child.id);
          this.store.appendEvent(child.id, scope.runId, 'task_created', {
            by: 'orchestrator',
            parent: scope.taskId
          });
          return this.text(res, rpcReq.id, child.id);
        }
        case 'kanban_feature_create': {
          const a = z.object({ name: z.string(), base_branch: z.string().optional() }).parse(args);
          const feature = this.store.createFeature({
            boardId: task.boardId,
            name: a.name,
            // Inherit the orchestrator's repo so member tasks need no folder re-setup.
            repoPath: task.repoPath,
            baseBranch: a.base_branch ?? task.baseBranch
          });
          this.store.appendEvent(feature.id, null, 'feature_created', {
            name: a.name,
            by: 'orchestrator'
          });
          return this.text(res, rpcReq.id, feature.id);
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
          const inheritRepo = this.inheritWorkspace(task);
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
