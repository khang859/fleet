import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { URL } from 'url';
import { z } from 'zod';
import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';

const log = createLogger('kanban-mcp');

export type McpRole = 'worker' | 'orchestrator';

interface RunScope {
  taskId: string;
  runId: number;
  role: McpRole;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';

const WORKER_TOOLS = [
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
    description: 'Block the task for human input. Prefix reason with "review-required: " for review.',
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
  }
];

export class KanbanMcpServer {
  private server: Server | null = null;
  private runs = new Map<string, RunScope>();
  private claimLocks = new Map<string, string>(); // token -> claim lock (for heartbeat)

  private store: KanbanStore;
  constructor(store: KanbanStore) {
    this.store = store;
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
      case 'tools/list':
        return this.rpcResult(res, rpcReq.id, { tools: WORKER_TOOLS });
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
          const a = z.object({ summary: z.string(), metadata: z.record(z.string(), z.unknown()).optional() }).parse(args);
          this.store.completeTask(task.id, a.summary);
          this.store.finishRun(scope.runId, 'completed', { summary: a.summary, metadata: a.metadata });
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
        case 'kanban_heartbeat': {
          const lock = this.claimLocks.get(token);
          if (lock) this.store.extendClaim(task.id, lock, 15 * 60 * 1000);
          this.store.appendEvent(task.id, scope.runId, 'heartbeat', {});
          return this.text(res, rpcReq.id, 'Heartbeat recorded.');
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
