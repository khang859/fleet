import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { URL } from 'url';
import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';
import type { KanbanCommands } from './kanban-commands';
import type { LearningsStore } from '../learnings/learnings-store';
import type {
  CreateTaskInput,
  RunMode,
  SwarmInput,
  SwarmCreated,
  Task,
  VerifyCommand
} from '../../shared/kanban-types';
import { PM_PROPOSAL_KINDS } from '../../shared/kanban-types';
import type { WorkerProfile } from '../../shared/types';
import { latestBlackboard, postBlackboardUpdate, isSwarmRoot } from './kanban-swarm';
import { finalizeWorktree, reviewStat, checkMergeConflicts, headSha } from './workspace';
import { pmDocsDir } from './pm-paths';
import { readArtifactPreview } from './artifact-files';
import { MAX_FANOUT } from './pipeline-templates';

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

/** Spawns a deterministic verify run for a worktree completion; returns its pid (undefined on spawn failure). */
export type VerifyRunner = (args: {
  runId: number;
  taskId: string;
  workspace: string;
  commands: VerifyCommand[];
}) => number | undefined;

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

const ASSIGN_TOOLS: McpTool[] = [
  ...WORKER_TOOLS.filter((t) => t.name === 'kanban_show'),
  {
    name: 'kanban_assign',
    description: 'Assign this task to a worker profile by name. Terminal — ends the assign run.',
    inputSchema: {
      type: 'object',
      properties: { profile: { type: 'string' } },
      required: ['profile']
    }
  },
  ...WORKER_TOOLS.filter((t) => t.name === 'kanban_comment' || t.name === 'kanban_heartbeat')
];

const RESOLVE_TOOLS: McpTool[] = WORKER_TOOLS.filter((t) =>
  ['kanban_show', 'kanban_comment', 'kanban_heartbeat', 'kanban_complete', 'kanban_block'].includes(
    t.name
  )
);

/**
 * Spec-stage (architect) tools: read the task + explore artifact, fan out implement
 * children via kanban_create (the create handler auto-wires links/feature), then finish.
 */
const SPEC_TOOLS: McpTool[] = [
  ...WORKER_TOOLS.filter((t) =>
    [
      'kanban_show',
      'kanban_comment',
      'kanban_heartbeat',
      'kanban_complete',
      'kanban_block'
    ].includes(t.name)
  ),
  ...ORCHESTRATOR_EXTRA_TOOLS.filter((t) => t.name === 'kanban_create')
];

const SUGGEST_TOOLS: McpTool[] = [
  ...WORKER_TOOLS.filter((t) => t.name === 'kanban_show'),
  // kanban_list lets the run inspect related tasks before grouping.
  ...ORCHESTRATOR_EXTRA_TOOLS.filter((t) => t.name === 'kanban_list'),
  {
    name: 'kanban_suggest_feature',
    description:
      'Record a pending grouping suggestion for a human to accept. Names a candidate feature ' +
      'and the task ids that should ship together. Terminal — ends the suggest run. Never ' +
      'creates a feature itself.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        task_ids: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' }
      },
      required: ['name', 'task_ids']
    }
  },
  ...WORKER_TOOLS.filter(
    (t) => t.name === 'kanban_comment' || t.name === 'kanban_heartbeat' || t.name === 'kanban_block'
  )
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
        docs: { type: 'array', items: { type: 'string' } },
        pipeline_template: { type: 'string', enum: ['full_feature', 'quick_fix'] }
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
    name: 'kanban_arm_decompose',
    description:
      'Flag a task for the dispatcher to break into subtasks on its next tick. ' +
      'Task must be in triage status.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id']
    }
  },
  {
    name: 'kanban_arm_specify',
    description:
      'Flag a task for the dispatcher to write a detailed spec on its next tick. ' +
      'Task must be in triage status.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id']
    }
  },
  {
    name: 'kanban_unblock',
    description:
      'Return a blocked task to ready. Optionally attach guidance as a comment for the next run.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, guidance: { type: 'string' } },
      required: ['task_id']
    }
  },
  {
    name: 'kanban_reassign',
    description: 'Reassign a task to a different worker profile by name.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, profile: { type: 'string' } },
      required: ['task_id', 'profile']
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
        description: { type: 'string' },
        verify_commands: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, command: { type: 'string' } },
            required: ['label', 'command']
          }
        }
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
  },
  {
    name: 'kanban_artifact_read',
    description:
      'Read the text content of a task artifact on this board (ids come from kanban_show). ' +
      'Use it to review finished work and distill durable knowledge into MEMORY.md or docs/.',
    inputSchema: {
      type: 'object',
      properties: { artifact_id: { type: 'string' } },
      required: ['artifact_id']
    }
  },
  {
    name: 'kanban_propose',
    description:
      'Propose a risky or irreversible board action for the human to confirm (Approve/Dismiss). ' +
      'Use for merges, opening PRs, completing, shipping a feature, or archiving — never act on these directly. ' +
      'kind is one of: merge_review_task, create_pr_for_task, accept_review_task, ship_feature, complete_task, archive_task. ' +
      'target_id is the task id (or feature id for ship_feature).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        target_id: { type: 'string' },
        rationale: { type: 'string' }
      },
      required: ['kind', 'target_id', 'rationale']
    }
  },
  {
    name: 'kanban_learning_create',
    description:
      'Save a durable, reusable learning to the cross-project knowledge base (semantically ' +
      'searchable by future workers). Use during a retro to capture a technical gotcha, a ' +
      'discovered constraint, or a pattern that worked. Pass feature_id (the shipped feature) ' +
      'so a re-run does not duplicate. Board-process notes belong in MEMORY.md, not here.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        project: { type: 'string' },
        feature_id: { type: 'string' }
      },
      required: ['title', 'body']
    }
  }
];

/** PM tools routed through execPmTool (synchronous; testable via callPmToolForTest). */
const PM_SYNC_TOOLS = new Set([
  'kanban_arm_decompose',
  'kanban_arm_specify',
  'kanban_unblock',
  'kanban_reassign',
  'kanban_set_status',
  'kanban_propose'
]);

const REVIEW_TOOLS: McpTool[] = [
  ...WORKER_TOOLS.filter((t) =>
    ['kanban_show', 'kanban_comment', 'kanban_heartbeat'].includes(t.name)
  ),
  {
    name: 'kanban_review_verdict',
    description:
      'Record the code-review verdict for this task. Terminal — ends the review run. ' +
      "decision is 'approve' or 'request_changes'; include specific findings on request_changes.",
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['approve', 'request_changes'] },
        summary: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: { file: { type: 'string' }, note: { type: 'string' } },
            required: ['note']
          }
        }
      },
      required: ['decision', 'summary']
    }
  }
];

/**
 * QA-stage tools: read the task, run/exercise the feature, then record the
 * feature-level verdict. kanban_qa_verdict is terminal — it ends the qa run.
 */
const QA_TOOLS: McpTool[] = [
  ...WORKER_TOOLS.filter((t) =>
    ['kanban_show', 'kanban_comment', 'kanban_heartbeat', 'kanban_artifact'].includes(t.name)
  ),
  {
    name: 'kanban_qa_verdict',
    description:
      "Record the feature-level QA verdict. decision 'pass' lets the feature PR become ready; " +
      "'request_changes' bounces the implement tasks for a fix.",
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['pass', 'request_changes'] },
        summary: { type: 'string' }
      },
      required: ['decision', 'summary']
    }
  }
];

function toolsForMode(mode: RunMode): McpTool[] {
  if (mode === 'decompose') return DECOMPOSE_TOOLS;
  if (mode === 'specify') return SPECIFY_TOOLS;
  if (mode === 'assign') return ASSIGN_TOOLS;
  if (mode === 'resolve') return RESOLVE_TOOLS;
  if (mode === 'spec') return SPEC_TOOLS;
  if (mode === 'suggest') return SUGGEST_TOOLS;
  if (mode === 'review') return REVIEW_TOOLS;
  if (mode === 'qa') return QA_TOOLS;
  return WORKER_TOOLS;
}

export class KanbanMcpServer {
  private server: Server | null = null;
  private runs = new Map<string, RunScope>();
  private claimLocks = new Map<string, string>(); // token -> claim lock (for heartbeat)

  private store: KanbanStore;
  private swarmHandler: ((input: SwarmInput) => SwarmCreated) | null = null;
  private commands: KanbanCommands | null = null;
  private verifyRunner: VerifyRunner | null = null;
  private kanbanHome: string | null = null;
  private learningsStore: LearningsStore | null = null;
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

  /** Inject the deterministic verify runner (spawns the verify shell; wired in index.ts over workerExits). */
  setVerifyRunner(runner: VerifyRunner): void {
    this.verifyRunner = runner;
  }

  /** Inject the kanban home so PM doc references can be validated against pm/<board>/docs. */
  setKanbanHome(home: string): void {
    this.kanbanHome = home;
  }

  /** Inject the learnings KB so the PM's retro turn can persist durable learnings. */
  setLearningsStore(store: LearningsStore): void {
    this.learningsStore = store;
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

  async start(port: number): Promise<number> {
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

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
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
    if (req.method !== 'POST') {
      this.send(res, 405, { error: 'method not allowed' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = url.searchParams.get('run') ?? '';
    const raw = await this.readBody(req);
    let rpcReq: JsonRpcRequest;
    try {
      rpcReq = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      this.send(res, 400, { error: 'bad json' });
      return;
    }

    switch (rpcReq.method) {
      case 'initialize': {
        this.rpcResult(res, rpcReq.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'fleet-kanban', version: '1' }
        });
        return;
      }
      case 'notifications/initialized':
        res.writeHead(202).end();
        return;
      case 'tools/list': {
        const scope = this.runs.get(token);
        if (scope?.kind === 'board') {
          this.rpcResult(res, rpcReq.id, { tools: PM_TOOLS });
          return;
        }
        this.rpcResult(res, rpcReq.id, { tools: toolsForMode(scope?.mode ?? 'work') });
        return;
      }
      case 'tools/call': {
        this.handleToolCall(res, rpcReq, token);
        return;
      }
      default: {
        this.rpcError(res, rpcReq.id, `unknown method: ${rpcReq.method}`);
        return;
      }
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

  /** For a spec-stage task, resolve the pipeline gate/qa task ids (feature-keyed; no parent walk). */
  private pipelineAnchor(
    specTask: Task
  ): { gateId: string; qaId: string; featureId: string } | null {
    if (specTask.pipelineStage !== 'spec' || !specTask.featureId) return null;
    return this.store.pipelineAnchorForFeature(specTask.featureId);
  }

  /** A task resolved by id, only if it lives on the PM scope's board. */
  private pmTask(scope: BoardScope, id: string): Task | null {
    const t = this.store.getTask(id);
    return t?.boardId === scope.boardId ? t : null;
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
    if (!commands) {
      this.rpcError(res, rpcReq.id, 'kanban commands are not available');
      return;
    }
    if (!PM_TOOLS.some((t) => t.name === name)) {
      this.rpcError(res, rpcReq.id, `unknown tool: ${name}`);
      return;
    }
    // These tools route through a synchronous, testable seam (execPmTool).
    if (PM_SYNC_TOOLS.has(name)) {
      try {
        this.text(res, rpcReq.id, this.execPmTool(scope, name, args));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.rpcError(res, rpcReq.id, msg);
      }
      return;
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
          this.text(res, rpcReq.id, lines.join('\n') || '(no tasks)');
          return;
        }
        case 'kanban_show': {
          const a = z.object({ task_id: z.string() }).parse(args);
          const detail = commands.show(a.task_id);
          if (detail?.task.boardId !== scope.boardId) {
            this.rpcError(res, rpcReq.id, `task not found on this board: ${a.task_id}`);
            return;
          }
          const { task, comments, runs, artifacts } = detail;
          const summaries = runs.filter((r) => r.summary);
          const kept = artifacts.filter((x) => x.state === 'kept');
          const lines = [
            `# ${task.title} (${task.id})`,
            `status: ${task.status}  priority: ${task.priority}  assignee: ${task.assignee ?? '-'}`,
            task.featureId ? `feature: ${task.featureId}` : '',
            task.docs.length ? `docs: ${task.docs.join(', ')}` : '',
            '',
            task.body || '(no body)',
            comments.length ? '## Comments' : '',
            ...comments.map((c) => `- ${c.author}: ${c.body}`),
            summaries.length ? '## Prior runs' : '',
            ...summaries.map((r) => `- ${r.outcome}: ${r.summary ?? ''}`),
            kept.length ? '## Artifacts' : '',
            ...kept.map(
              (x) =>
                `- ${x.id}: ${x.filename}${x.title ? ` — ${x.title}` : ''} (${x.kind}, ${x.size} bytes)`
            )
          ].filter(Boolean);
          this.text(res, rpcReq.id, lines.join('\n'));
          return;
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
              docs: z.array(z.string()).optional(),
              pipeline_template: z.enum(['full_feature', 'quick_fix']).optional()
            })
            .parse(args);
          if (a.docs && a.docs.length > 0) {
            const docErr = this.validateDocs(scope.boardId, a.docs);
            if (docErr) {
              this.rpcError(res, rpcReq.id, docErr);
              return;
            }
          }
          // Same phantom-assignee guard as the orchestrator's kanban_create.
          const assignee = a.assignee?.trim() || null;
          const workerNames = this.getProfiles()
            .filter((p) => p.role === 'worker')
            .map((p) => p.name);
          if (assignee && workerNames.length > 0 && !workerNames.includes(assignee)) {
            this.rpcError(
              res,
              rpcReq.id,
              `unknown worker profile "${assignee}". Valid profiles: ${workerNames.join(', ')}`
            );
            return;
          }
          // Workspace routing precedence: feature repo (keeps the group integrable) >
          // explicit project > board default project > scratch.
          let workspace: Partial<
            Pick<CreateTaskInput, 'workspaceKind' | 'repoPath' | 'baseBranch'>
          > = { workspaceKind: 'scratch' };
          let featureRepo: string | null = null;
          if (a.feature_id) {
            const feature = this.store.getFeature(a.feature_id);
            if (feature?.boardId !== scope.boardId) {
              this.rpcError(res, rpcReq.id, `feature not found on this board: ${a.feature_id}`);
              return;
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
            this.rpcError(res, rpcReq.id, `unknown project "${a.project}". Registered: ${names}`);
            return;
          }
          if (proj && featureRepo && proj.path !== featureRepo) {
            this.rpcError(
              res,
              rpcReq.id,
              `project "${proj.name}" conflicts with the feature repo (${featureRepo}); omit project or match it`
            );
            return;
          }
          if (!proj && !featureRepo) proj = projects.find((p) => p.isDefault) ?? null;
          if (proj && !featureRepo) {
            workspace = { workspaceKind: 'worktree', repoPath: proj.path };
          }
          for (const p of a.parents ?? []) {
            if (!this.pmTask(scope, p)) {
              this.rpcError(res, rpcReq.id, `parent task not found on this board: ${p}`);
              return;
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
            pipelineTemplate: a.pipeline_template ?? null,
            ...workspace
          });
          for (const p of a.parents ?? []) commands.link(p, task.id);
          this.text(res, rpcReq.id, task.id);
          return;
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
            this.rpcError(res, rpcReq.id, `task not found on this board: ${a.task_id}`);
            return;
          }
          // A running worker reads its task via kanban_show mid-turn; editing it
          // out from under the worker is dispatcher territory, same as status.
          if (existing.status === 'running') {
            this.rpcError(res, rpcReq.id, 'cannot update a running task');
            return;
          }
          if (a.docs && a.docs.length > 0) {
            const docErr = this.validateDocs(scope.boardId, a.docs);
            if (docErr) {
              this.rpcError(res, rpcReq.id, docErr);
              return;
            }
          }
          commands.update(a.task_id, {
            title: a.title,
            body: a.body,
            priority: a.priority,
            ...(a.assignee !== undefined ? { assignee: a.assignee.trim() || null } : {}),
            ...(a.docs !== undefined ? { docs: a.docs } : {})
          });
          this.text(res, rpcReq.id, 'Task updated.');
          return;
        }
        case 'kanban_comment': {
          const a = z.object({ task_id: z.string(), body: z.string() }).parse(args);
          if (!this.pmTask(scope, a.task_id)) {
            this.rpcError(res, rpcReq.id, `task not found on this board: ${a.task_id}`);
            return;
          }
          this.store.addComment(a.task_id, 'pm', a.body);
          this.store.appendEvent(a.task_id, null, 'comment_added', { author: 'pm' });
          this.text(res, rpcReq.id, 'Comment added.');
          return;
        }
        case 'kanban_link': {
          const a = z.object({ parent_id: z.string(), child_id: z.string() }).parse(args);
          if (!this.pmTask(scope, a.parent_id) || !this.pmTask(scope, a.child_id)) {
            this.rpcError(res, rpcReq.id, 'both tasks must exist on this board');
            return;
          }
          commands.link(a.parent_id, a.child_id);
          this.text(res, rpcReq.id, 'Linked.');
          return;
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
            if (repoPath) {
              this.rpcError(res, rpcReq.id, 'pass either project or repo_path, not both');
              return;
            }
            const p = this.store.getProjectByName(scope.boardId, a.project);
            if (!p) {
              this.rpcError(res, rpcReq.id, `unknown project: ${a.project}`);
              return;
            }
            repoPath = p.path;
          }
          const feature = commands.createFeature({
            boardId: scope.boardId,
            name: a.name,
            repoPath,
            baseBranch: a.base_branch ?? null
          });
          this.text(res, rpcReq.id, feature.id);
          return;
        }
        case 'kanban_assign_feature': {
          const a = z
            .object({ task_id: z.string(), feature_id: z.union([z.string(), z.null()]) })
            .parse(args);
          if (!this.pmTask(scope, a.task_id)) {
            this.rpcError(res, rpcReq.id, `task not found on this board: ${a.task_id}`);
            return;
          }
          commands.assignTaskToFeature(a.task_id, a.feature_id);
          this.text(res, rpcReq.id, 'Feature membership updated.');
          return;
        }
        case 'kanban_project_list': {
          const projects = this.store.listProjects(scope.boardId);
          const lines = projects.map((p) => {
            const desc = p.description ? ` — ${p.description}` : '';
            return `- ${p.name} → ${p.path}${desc}${p.isDefault ? ' (default)' : ''}`;
          });
          this.text(res, rpcReq.id, lines.join('\n') || '(no projects registered)');
          return;
        }
        case 'kanban_project_add': {
          const a = z
            .object({
              name: z.string(),
              path: z.string(),
              description: z.string().optional(),
              verify_commands: z
                .array(z.object({ label: z.string().min(1), command: z.string().min(1) }))
                .optional()
            })
            .parse(args);
          const p = commands.addProject({
            boardId: scope.boardId,
            name: a.name,
            path: a.path,
            description: a.description ?? null,
            verifyCommands: a.verify_commands
          });
          this.text(
            res,
            rpcReq.id,
            `Project "${p.name}" registered${p.isDefault ? ' as the default' : ''}.`
          );
          return;
        }
        case 'kanban_project_remove': {
          const a = z.object({ name: z.string() }).parse(args);
          const p = this.store.getProjectByName(scope.boardId, a.name);
          if (!p) {
            this.rpcError(res, rpcReq.id, `project not found on this board: ${a.name}`);
            return;
          }
          commands.removeProject(p.id);
          this.text(res, rpcReq.id, `Project "${a.name}" removed.`);
          return;
        }
        case 'kanban_artifact_read': {
          const a = z.object({ artifact_id: z.string() }).parse(args);
          const art = this.store.getArtifact(a.artifact_id);
          if (art?.boardId !== scope.boardId) {
            this.rpcError(res, rpcReq.id, `artifact not found on this board: ${a.artifact_id}`);
            return;
          }
          const preview = readArtifactPreview(art.storedPath, 64 * 1024);
          if (!preview.previewable) {
            this.rpcError(res, rpcReq.id, preview.reason ?? 'artifact is not readable as text');
            return;
          }
          const suffix = preview.truncated ? '\n\n…(truncated)' : '';
          this.text(res, rpcReq.id, (preview.text ?? '') + suffix);
          return;
        }
        case 'kanban_learning_create': {
          const ls = this.learningsStore;
          if (!ls) {
            this.rpcError(res, rpcReq.id, 'learnings store is not available');
            return;
          }
          const a = z
            .object({
              title: z.string().min(1),
              body: z.string().min(1),
              tags: z.array(z.string()).optional(),
              project: z.string().optional(),
              feature_id: z.string().optional()
            })
            .parse(args);
          const defaultProject = this.store
            .listProjects(scope.boardId)
            .find((p) => p.isDefault)?.name;
          const learning = ls.create({
            title: a.title,
            body: a.body,
            tags: ['retro', ...(a.tags ?? [])],
            sourceProject: a.project ?? defaultProject,
            sourceSessionId: a.feature_id
          });
          this.text(res, rpcReq.id, `Learning saved: ${learning.id}`);
          return;
        }
        default: {
          this.rpcError(res, rpcReq.id, `unknown tool: ${name}`);
          return;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.rpcError(res, rpcReq.id, msg);
      return;
    }
  }

  /**
   * Synchronous dispatch for the PM safe authority tools (arm/unblock/reassign).
   * All mutations route through KanbanCommands so the autopilot obeys the same
   * validation as the UI. Returns the result text or throws.
   */
  private execPmTool(scope: BoardScope, name: string, args: Record<string, unknown>): string {
    const commands = this.commands;
    if (!commands) throw new Error('kanban commands are not available');
    switch (name) {
      case 'kanban_arm_decompose': {
        const a = z.object({ task_id: z.string() }).parse(args);
        this.requirePmTask(scope, a.task_id);
        commands.requestDecompose(a.task_id);
        return `Armed decompose for ${a.task_id}.`;
      }
      case 'kanban_arm_specify': {
        const a = z.object({ task_id: z.string() }).parse(args);
        this.requirePmTask(scope, a.task_id);
        commands.requestSpecify(a.task_id);
        return `Armed specify for ${a.task_id}.`;
      }
      case 'kanban_unblock': {
        const a = z.object({ task_id: z.string(), guidance: z.string().optional() }).parse(args);
        this.requirePmTask(scope, a.task_id);
        const guidance = a.guidance?.trim() ?? '';
        // Author guidance as 'pm' (mirrors the legacy kanban_comment PM tool) so it
        // doesn't masquerade as a human comment; commands.comment hardcodes 'human'.
        if (guidance) {
          this.store.addComment(a.task_id, 'pm', `PM guidance: ${guidance}`);
          this.store.appendEvent(a.task_id, null, 'comment_added', { author: 'pm' });
        }
        commands.unblock(a.task_id);
        return `Unblocked ${a.task_id}.`;
      }
      case 'kanban_reassign': {
        const a = z.object({ task_id: z.string(), profile: z.string() }).parse(args);
        this.requirePmTask(scope, a.task_id);
        const profile = a.profile.trim();
        if (!profile) throw new Error('profile is required');
        // Same phantom-assignee guard as the PM kanban_create.
        const workerNames = this.getProfiles()
          .filter((p) => p.role === 'worker')
          .map((p) => p.name);
        if (workerNames.length > 0 && !workerNames.includes(profile)) {
          throw new Error(
            `unknown worker profile "${profile}". Valid profiles: ${workerNames.join(', ')}`
          );
        }
        commands.assign(a.task_id, profile);
        return `Reassigned ${a.task_id} to ${profile}.`;
      }
      case 'kanban_set_status': {
        const a = z
          .object({ task_id: z.string(), status: z.enum(PM_SETTABLE_STATUSES) })
          .parse(args);
        this.requirePmTask(scope, a.task_id);
        // Guardrail: a worktree-backed task carries committed work that must merge
        // (or be explicitly accepted) through a human-confirmed proposal — it can't
        // skip the review gate by being marked done directly.
        if (a.status === 'done') {
          const task = this.store.getTask(a.task_id);
          if (task?.workspaceKind === 'worktree') {
            throw new Error(
              'worktree-backed tasks cannot be set done directly; use kanban_propose with merge_review_task or accept_review_task'
            );
          }
        }
        commands.setManualStatus(a.task_id, a.status);
        return `Task ${a.task_id} moved to ${a.status}.`;
      }
      case 'kanban_propose': {
        const a = z
          .object({
            kind: z.enum(PM_PROPOSAL_KINDS),
            target_id: z.string().min(1),
            rationale: z.string().min(1)
          })
          .parse(args);
        // ship_feature targets a feature id; every other kind targets a task that
        // must live on this board (proposeAction→requireTask only checks global existence).
        if (a.kind !== 'ship_feature') this.requirePmTask(scope, a.target_id);
        const p = commands.proposeAction(scope.boardId, a.kind, a.target_id, a.rationale);
        return `proposed ${a.kind} for ${a.target_id} (awaiting confirmation, id ${p.id})`;
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  /** Throws if the task does not exist on the PM scope's board. */
  private requirePmTask(scope: BoardScope, id: string): void {
    if (!this.pmTask(scope, id)) {
      throw new Error(`task not found on this board: ${id}`);
    }
  }

  /** Test-only: invoke a PM safe tool synchronously without the HTTP/RPC layer. */
  callPmToolForTest(name: string, args: Record<string, unknown>, scope: BoardScope): string {
    return this.execPmTool(scope, name, args);
  }

  private handleToolCall(res: ServerResponse, rpcReq: JsonRpcRequest, token: string): void {
    const scope = this.runs.get(token);
    if (!scope) {
      this.rpcError(res, rpcReq.id, 'unknown or missing run token');
      return;
    }

    const params = rpcReq.params ?? {};
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (scope.kind === 'board') {
      this.handlePmToolCall(res, rpcReq, scope, name, args);
      return;
    }
    const task = this.store.getTask(scope.taskId);
    if (!task) {
      this.rpcError(res, rpcReq.id, `task ${scope.taskId} not found`);
      return;
    }
    const author = scope.mode === 'review' ? 'reviewer' : (task.assignee ?? 'worker');

    const allowed = toolsForMode(scope.mode).some((t) => t.name === name);
    if (!allowed) {
      this.rpcError(res, rpcReq.id, `unknown tool: ${name}`);
      return;
    }

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
          this.text(res, rpcReq.id, lines.join('\n'));
          return;
        }
        case 'kanban_review_verdict': {
          const a = z
            .object({
              decision: z.enum(['approve', 'request_changes']),
              summary: z.string().min(1),
              findings: z
                .array(z.object({ file: z.string().optional(), note: z.string().min(1) }))
                .optional()
            })
            .parse(args);
          // CAS guard: only the current review run on a still-running task may record.
          if (scope.runId !== task.currentRunId || task.status !== 'running') {
            this.unregisterRun(token);
            this.text(res, rpcReq.id, `Verdict ignored: task ${task.id} moved on.`);
            return;
          }
          const sha =
            a.decision === 'approve' && task.workspacePath ? headSha(task.workspacePath) : null;
          this.store.setReviewVerdict(task.id, a.decision, sha);
          const findingsText = (a.findings ?? [])
            .map((f) => `- ${f.file ? `${f.file}: ` : ''}${f.note}`)
            .join('\n');
          this.store.addComment(
            task.id,
            'reviewer',
            `review ${a.decision}: ${a.summary}${findingsText ? `\n${findingsText}` : ''}`
          );
          this.store.appendEvent(
            task.id,
            scope.runId,
            a.decision === 'approve' ? 'review_passed' : 'review_changes_requested',
            { summary: a.summary, findings: a.findings ?? [] }
          );
          this.store.finishRun(scope.runId, 'completed', { summary: a.summary });
          this.unregisterRun(token);
          this.text(res, rpcReq.id, `Verdict recorded for task ${task.id}.`);
          return;
        }
        case 'kanban_qa_verdict': {
          const a = z
            .object({
              decision: z.enum(['pass', 'request_changes']),
              summary: z.string().min(1)
            })
            .parse(args);
          if (scope.runId !== task.currentRunId || task.status !== 'running') {
            this.unregisterRun(token);
            this.text(res, rpcReq.id, `Verdict ignored: task ${task.id} moved on.`);
            return;
          }
          if (!task.featureId) {
            this.rpcError(res, rpcReq.id, 'qa task has no feature');
            return;
          }
          this.store.setQaVerdict(task.featureId, a.decision);
          this.store.addComment(task.id, 'qa', `qa ${a.decision}: ${a.summary}`);
          this.store.appendEvent(
            task.id,
            scope.runId,
            a.decision === 'pass' ? 'qa_passed' : 'qa_changes_requested',
            { summary: a.summary }
          );
          // Close the run before mutating the task (mirrors kanban_review_verdict):
          // 'pass' completes the qa task (it satisfies the rollup); 'request_changes'
          // leaves re-arming to the dispatcher (Task 11).
          this.store.finishRun(scope.runId, 'completed', { summary: a.summary });
          if (a.decision === 'pass') {
            this.store.completeTask(task.id, `QA pass: ${a.summary}`);
          }
          this.unregisterRun(token);
          this.text(res, rpcReq.id, `QA verdict recorded for feature ${task.featureId}.`);
          return;
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
            const where = task.branchName ?? `kanban/${task.id}`;
            const statText = stat
              ? `${stat.files} file${stat.files === 1 ? '' : 's'} (+${stat.insertions}/−${stat.deletions})`
              : 'changes committed';

            // Deterministic verify gate (#231): only for genuine worktree diffs
            // (work/resolve), and only when the task's project has verify commands.
            const project = task.repoPath
              ? this.store.getProjectByPath(task.boardId, task.repoPath)
              : null;
            const commands = project?.verifyCommands ?? [];
            const gated =
              (scope.mode === 'work' || scope.mode === 'resolve') && commands.length > 0;

            if (gated && this.verifyRunner) {
              // Persist the work summary and free the work run row, but do NOT emit a
              // 'completed' event (it would fire a premature "Completed" notification).
              this.store.finishRun(scope.runId, 'completed', {
                summary: a.summary,
                metadata: { ...a.metadata, review: stat ?? undefined }
              });
              this.store.appendEvent(task.id, scope.runId, 'verify_started', {});
              const verify = this.store.startRun(task.id, null, null, 'verify');
              const pid = this.verifyRunner({
                runId: verify.id,
                taskId: task.id,
                workspace: task.workspacePath,
                commands
              });
              if (pid != null) {
                this.store.setWorkerPid(task.id, verify.id, pid);
                const lock = this.claimLocks.get(token);
                if (lock) this.store.extendClaim(task.id, lock, 15 * 60 * 1000);
                this.store.addComment(task.id, author, `verifying: ${statText} on ${where}`);
                this.unregisterRun(token);
                this.text(res, rpcReq.id, `Task ${task.id} committed; verifying.`);
                return;
              }
              // Spawn failed → close the orphaned verify run and fail open to review.
              this.store.finishRun(verify.id, 'spawn_failed');
              this.store.reviewTask(task.id, a.summary);
              if (task.repoPath && task.branchName && task.baseBranch) {
                const c = checkMergeConflicts({
                  repoPath: task.repoPath,
                  baseBranch: task.baseBranch,
                  branchName: task.branchName
                });
                this.store.setTaskConflict(task.id, c.state, c.files);
              }
              this.store.appendEvent(task.id, verify.id, 'verify_skipped', {
                reason: 'verify spawn failed'
              });
              this.store.addComment(task.id, author, `review-required: ${statText} on ${where}`);
              this.unregisterRun(token);
              this.text(res, rpcReq.id, `Task ${task.id} ready for review.`);
              return;
            }

            // Ungated path (UNCHANGED behavior — must match the original exactly).
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
            this.store.appendEvent(task.id, scope.runId, 'review_ready', { summary: a.summary });
            this.store.addComment(task.id, author, `review-required: ${statText} on ${where}`);
            this.unregisterRun(token);
            this.text(res, rpcReq.id, `Task ${task.id} ready for review.`);
            return;
          }
          this.store.completeTask(task.id, a.summary);
          this.store.finishRun(scope.runId, 'completed', {
            summary: a.summary,
            metadata: a.metadata
          });
          this.store.appendEvent(task.id, scope.runId, 'completed', { summary: a.summary });
          if (scope.mode === 'decompose') this.commands?.enforceDecomposeGrouping(task.id);
          this.unregisterRun(token);
          this.text(res, rpcReq.id, `Task ${task.id} marked done.`);
          return;
        }
        case 'kanban_block': {
          const a = z.object({ reason: z.string() }).parse(args);
          if (scope.mode === 'suggest') {
            // The transient detection task is never parked on the board — drop it.
            this.store.finishRun(scope.runId, 'blocked', { summary: a.reason });
            this.store.deleteTask(task.id);
            this.unregisterRun(token);
            this.text(res, rpcReq.id, 'No grouping suggested.');
            return;
          }
          this.store.blockTask(task.id, a.reason);
          this.store.finishRun(scope.runId, 'blocked', { summary: a.reason });
          this.store.appendEvent(task.id, scope.runId, 'blocked', { reason: a.reason });
          this.unregisterRun(token);
          this.text(res, rpcReq.id, `Task ${task.id} blocked.`);
          return;
        }
        case 'kanban_assign': {
          const a = z.object({ profile: z.string() }).parse(args);
          const profile = a.profile.trim();
          if (!profile) {
            this.rpcError(res, rpcReq.id, 'profile is required');
            return;
          }
          const workerNames = this.getProfiles()
            .filter((p) => p.role === 'worker')
            .map((p) => p.name);
          if (workerNames.length > 0 && !workerNames.includes(profile)) {
            this.rpcError(
              res,
              rpcReq.id,
              `unknown worker profile "${profile}". Valid profiles: ${workerNames.join(', ')}`
            );
            return;
          }
          this.store.updateTask(task.id, { assignee: profile });
          // assign phase done — reset failures so they don't eat the work phase's retry budget
          this.store.clearFailures(task.id);
          this.store.returnToReady(task.id);
          this.store.finishRun(scope.runId, 'completed', { summary: `assigned ${profile}` });
          this.store.appendEvent(task.id, scope.runId, 'assigned', {
            assignee: profile,
            by: 'orchestrator'
          });
          this.unregisterRun(token);
          this.text(res, rpcReq.id, `Assigned ${profile}.`);
          return;
        }
        case 'kanban_suggest_feature': {
          const a = z
            .object({
              name: z.string(),
              task_ids: z.array(z.string()),
              reason: z.string().optional()
            })
            .parse(args);
          // Only keep ids that still exist and belong to this detection task's board.
          const validIds = a.task_ids.filter((tid) => {
            const t = this.store.getTask(tid);
            return t?.boardId === task.boardId;
          });
          if (validIds.length === 0) {
            // Nothing real to group — don't write an empty pending row that would
            // wedge the per-repo detection gate. Treat it like "no grouping".
            this.store.finishRun(scope.runId, 'completed', { summary: 'no valid tasks to group' });
            this.store.deleteTask(task.id);
            this.unregisterRun(token);
            this.text(res, rpcReq.id, 'No grouping suggested.');
            return;
          }
          this.store.createSuggestion({
            boardId: task.boardId,
            repoPath: task.repoPath ?? null,
            name: a.name,
            taskIds: validIds,
            reason: a.reason ?? null
          });
          this.store.finishRun(scope.runId, 'completed', {
            summary: `suggested feature "${a.name}" (${validIds.length} tasks)`
          });
          // Drop the transient detection task — the suggestion lives in its own table now.
          this.store.deleteTask(task.id);
          this.unregisterRun(token);
          this.text(res, rpcReq.id, `Suggested feature "${a.name}".`);
          return;
        }
        case 'kanban_comment': {
          const a = z.object({ body: z.string() }).parse(args);
          this.store.addComment(task.id, author, a.body);
          this.store.appendEvent(task.id, scope.runId, 'comment', { author });
          this.text(res, rpcReq.id, 'Comment added.');
          return;
        }
        case 'kanban_swarm_read': {
          const a = z.object({ root: z.string() }).parse(args);
          if (!isSwarmRoot(this.store, a.root)) {
            this.rpcError(res, rpcReq.id, `${a.root} is not a swarm root`);
            return;
          }
          this.text(res, rpcReq.id, JSON.stringify(latestBlackboard(this.store, a.root)));
          return;
        }
        case 'kanban_swarm_post': {
          const a = z.object({ root: z.string(), key: z.string(), value: z.unknown() }).parse(args);
          if (!isSwarmRoot(this.store, a.root)) {
            this.rpcError(res, rpcReq.id, `${a.root} is not a swarm root`);
            return;
          }
          if (a.key === '_authors') {
            this.rpcError(res, rpcReq.id, '"_authors" is a reserved blackboard key');
            return;
          }
          postBlackboardUpdate(this.store, a.root, author, a.key, a.value);
          this.store.appendEvent(a.root, null, 'blackboard_post', { author, key: a.key });
          this.text(res, rpcReq.id, 'Blackboard updated.');
          return;
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
            this.rpcError(res, rpcReq.id, 'workspace not ready');
            return;
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
          this.text(res, rpcReq.id, artifact.id);
          return;
        }
        case 'kanban_heartbeat': {
          const lock = this.claimLocks.get(token);
          if (lock) this.store.extendClaim(task.id, lock, 15 * 60 * 1000);
          this.store.appendEvent(task.id, scope.runId, 'heartbeat', {});
          this.text(res, rpcReq.id, 'Heartbeat recorded.');
          return;
        }
        case 'kanban_list': {
          const a = z
            .object({ status: z.string().optional(), assignee: z.string().optional() })
            .parse(args);
          let rows = this.store.listBoard();
          if (a.status) rows = rows.filter((c) => c.status === a.status);
          if (a.assignee) rows = rows.filter((c) => c.assignee === a.assignee);
          const lines = rows.map((c) => `${c.id}\t${c.status}\t${c.assignee ?? '-'}\t${c.title}`);
          this.text(res, rpcReq.id, lines.join('\n') || '(no tasks)');
          return;
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
            this.rpcError(
              res,
              rpcReq.id,
              `unknown worker profile "${assignee}". Valid profiles: ${workerNames.join(', ')}`
            );
            return;
          }
          const anchor = this.pipelineAnchor(task);
          if (anchor) {
            // Idempotency keyed on the RUN, not on existence of children. The first child a
            // run creates stamps `children_emitted` with that runId. A reclaim re-run is a
            // DIFFERENT run: if a children_emitted event from another run exists, this run's
            // fan-out is a duplicate — reject it so the prior children stand. Within the same
            // run, subsequent kanban_create calls share the runId and are allowed.
            const emittedEvents = this.store
              .listEvents(task.id)
              .filter((e) => e.kind === 'children_emitted');
            const priorRun = emittedEvents.find((e) => e.payload?.runId !== scope.runId);
            if (priorRun) {
              this.rpcError(
                res,
                rpcReq.id,
                'children already emitted by a prior run; call kanban_complete'
              );
              return;
            }
            // Implement children link off the gate (not the spec task), so count the
            // gate's implement-stage children to enforce the cap.
            const existing = this.store
              .childrenOf(anchor.gateId)
              .filter((id) => this.store.getTask(id)?.pipelineStage === 'implement').length;
            if (existing >= MAX_FANOUT) {
              this.rpcError(
                res,
                rpcReq.id,
                `fan-out cap reached (${MAX_FANOUT}); stop creating children and call kanban_complete`
              );
              return;
            }
            const child = this.store.createTask({
              title: a.title,
              body: a.body ?? '',
              assignee,
              priority: a.priority ?? 0,
              status: 'todo',
              boardId: task.boardId,
              ...this.inheritWorkspace(task),
              featureId: anchor.featureId,
              pipelineStage: 'implement'
            });
            this.store.addLink(anchor.gateId, child.id); // held until approval
            this.store.addLink(child.id, anchor.qaId); // QA waits for it
            this.store.appendEvent(child.id, scope.runId, 'task_created', {
              by: 'architect',
              parent: task.id
            });
            if (emittedEvents.length === 0) {
              this.store.appendEvent(task.id, scope.runId, 'children_emitted', {
                runId: scope.runId
              });
            }
            this.text(res, rpcReq.id, child.id);
            return;
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
          this.text(res, rpcReq.id, child.id);
          return;
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
          this.text(res, rpcReq.id, feature.id);
          return;
        }
        case 'kanban_link': {
          const a = z.object({ parent_id: z.string(), child_id: z.string() }).parse(args);
          this.store.addLink(a.parent_id, a.child_id);
          this.store.appendEvent(a.child_id, scope.runId, 'link_added', { parentId: a.parent_id });
          this.text(res, rpcReq.id, 'Linked.');
          return;
        }
        case 'kanban_unblock': {
          const a = z.object({ task_id: z.string() }).parse(args);
          this.store.setStatus(a.task_id, 'ready');
          this.store.appendEvent(a.task_id, scope.runId, 'status_changed', {
            to: 'ready',
            by: 'orchestrator'
          });
          this.text(res, rpcReq.id, 'Unblocked.');
          return;
        }
        case 'kanban_swarm': {
          if (!this.swarmHandler) {
            this.rpcError(res, rpcReq.id, 'swarm creation is not available');
            return;
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
          this.text(res, rpcReq.id, JSON.stringify(created));
          return;
        }
        case 'kanban_update': {
          const a = z.object({ title: z.string().optional(), body: z.string() }).parse(args);
          this.store.updateTask(task.id, { title: a.title, body: a.body });
          this.store.appendEvent(task.id, scope.runId, 'task_updated', { by: 'orchestrator' });
          this.store.setStatusCleared(task.id, 'todo');
          this.store.finishRun(scope.runId, 'completed', { summary: 'specified' });
          this.unregisterRun(token);
          this.text(res, rpcReq.id, `Task ${task.id} specified.`);
          return;
        }
        default: {
          this.rpcError(res, rpcReq.id, `unknown tool: ${name}`);
          return;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.rpcError(res, rpcReq.id, msg);
      return;
    }
  }
}
