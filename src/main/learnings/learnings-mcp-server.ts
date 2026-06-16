// src/main/learnings/learnings-mcp-server.ts
// A loopback MCP server exposing the Learnings KB to agents (Rune + Claude Code).
// Read-only, no auth token — the 127.0.0.1 bind is the security boundary. Mirrors the
// JSON-RPC shape of KanbanMcpServer.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { z } from 'zod';
import { createLogger } from '../logger';
import { learningToMarkdown, type Learning } from '../../shared/learnings';
import type { LearningsStore } from './learnings-store';
import type { LearningsSearchService } from './search-service';

const log = createLogger('learnings-mcp');

const PROTOCOL_VERSION = '2024-11-05';

/** Cap on the JSON-RPC request body. Any local process can POST here; without a limit
 *  a multi-GB body would exhaust the main process's heap. 1 MiB is far above any real
 *  tools/call payload. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Sentinel so the handler can answer an over-limit body with 413 specifically. */
class BodyTooLargeError extends Error {}

/** Read a request body into a string, aborting once it exceeds `max` bytes. */
async function readBody(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    // IncomingMessage in binary mode (we never setEncoding) yields Buffers; the guard
    // narrows the async-iterator's `any` without an unsafe assertion.
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > max) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

const TOOLS = [
  {
    name: 'learnings_search',
    description:
      'Semantic + keyword search over the Fleet Learnings KB: durable engineering lessons, ' +
      'gotchas, and fixes distilled from past coding sessions across all your projects. ' +
      'Search this before non-trivial work to surface known pitfalls and prior solutions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language description of what you are working on'
        },
        limit: { type: 'number', description: 'Max results (default 5, max 20)' },
        tag: { type: 'string', description: 'Restrict to learnings carrying this tag' },
        project: { type: 'string', description: 'Restrict to learnings from this source project' }
      },
      required: ['query']
    }
  },
  {
    name: 'learnings_get',
    description: 'Fetch the full markdown of one learning by id (ids come from learnings_search).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  }
] as const;

const SearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
  tag: z.string().optional(),
  project: z.string().optional()
});
const GetArgs = z.object({ id: z.string().min(1).max(128) });

// The JSON-RPC envelope is untrusted (loopback, but any local process can POST).
// Parse it with zod so a malformed body is a clean 400, not a thrown cast.
const RpcRequestSchema = z.object({
  jsonrpc: z.string().optional(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  method: z.string(),
  params: z
    .object({
      name: z.string().optional(),
      arguments: z.record(z.string(), z.unknown()).optional()
    })
    .optional()
});
type RpcRequest = z.infer<typeof RpcRequestSchema>;

/** Compact a learning for a search hit: heading + provenance + a body excerpt. */
function renderHit(l: Learning): string {
  const meta = [
    l.tags.length ? `tags: ${l.tags.join(', ')}` : '',
    l.sourceProject ? `project: ${l.sourceProject}` : ''
  ]
    .filter(Boolean)
    .join('  |  ');
  const excerpt = l.body.length > 600 ? `${l.body.slice(0, 600)}…` : l.body;
  return [`## ${l.title}`, `id: ${l.id}${meta ? `  •  ${meta}` : ''}`, '', excerpt].join('\n');
}

export class LearningsMcpServer {
  private server: Server | null = null;

  constructor(
    private readonly store: LearningsStore,
    private readonly search: LearningsSearchService
  ) {}

  /** Listen on `preferredPort`; on conflict fall back to an OS-assigned port. Returns the bound port. */
  async start(preferredPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          log.error('handler error', { error: err instanceof Error ? err.message : String(err) });
          this.send(res, 500, { error: 'internal' });
        });
      });
      // Persistent (not once) so a failure of the fallback listen(0) is also caught —
      // otherwise its error would be an unhandled 'error' event (process crash) or the
      // promise would hang forever. `triedFallback` ensures we only retry once.
      let triedFallback = false;
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && !triedFallback) {
          triedFallback = true;
          log.warn('learnings MCP port in use; using an OS-assigned port', { preferredPort });
          server.listen(0, '127.0.0.1');
        } else {
          reject(err);
        }
      });
      server.listen(preferredPort, '127.0.0.1', () => {
        const addr = server.address();
        const bound = typeof addr === 'object' && addr ? addr.port : preferredPort;
        this.server = server;
        log.info('learnings mcp server listening', { port: bound });
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
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private rpcResult(res: ServerResponse, id: RpcRequest['id'], result: unknown): void {
    this.send(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
  }

  private rpcError(res: ServerResponse, id: RpcRequest['id'], message: string): void {
    this.send(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } });
  }

  private text(res: ServerResponse, id: RpcRequest['id'], message: string): void {
    this.rpcResult(res, id, { content: [{ type: 'text', text: message }] });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.send(res, 405, { error: 'method not allowed' });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        this.send(res, 413, { error: 'request too large' });
        return;
      }
      throw err;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      this.send(res, 400, { error: 'bad json' });
      return;
    }
    const parsed = RpcRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      this.send(res, 400, { error: 'invalid json-rpc request' });
      return;
    }
    const rpc = parsed.data;

    switch (rpc.method) {
      case 'initialize': {
        this.rpcResult(res, rpc.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'fleet-learnings', version: '1' }
        });
        return;
      }
      case 'notifications/initialized':
        res.writeHead(202).end();
        return;
      case 'tools/list': {
        this.rpcResult(res, rpc.id, { tools: TOOLS });
        return;
      }
      case 'tools/call':
        return this.handleToolCall(res, rpc);
      default: {
        this.rpcError(res, rpc.id, 'unknown method');
        return;
      }
    }
  }

  private async handleToolCall(res: ServerResponse, rpc: RpcRequest): Promise<void> {
    const name = rpc.params?.name ?? '';
    const args = rpc.params?.arguments ?? {};
    try {
      if (name === 'learnings_search') {
        const a = SearchArgs.parse(args);
        const limit = a.limit ?? 5;
        const results = await this.search.hybridSearch(
          a.query,
          { project: a.project, tag: a.tag },
          limit
        );
        if (results.length === 0) {
          this.text(res, rpc.id, 'No matching learnings found.');
          return;
        }
        this.text(res, rpc.id, results.map(renderHit).join('\n\n---\n\n'));
        return;
      }
      if (name === 'learnings_get') {
        const a = GetArgs.parse(args);
        const l = this.store.get(a.id);
        if (!l) {
          // Don't echo the (untrusted) id back in the message.
          this.rpcError(res, rpc.id, 'learning not found');
          return;
        }
        this.text(res, rpc.id, learningToMarkdown(l));
        return;
      }
      this.rpcError(res, rpc.id, 'unknown tool');
      return;
    } catch (err) {
      this.rpcError(res, rpc.id, err instanceof Error ? err.message : String(err));
      return;
    }
  }
}
