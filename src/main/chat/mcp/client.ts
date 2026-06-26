import { z } from 'zod';
import type { Transport } from './transport';

const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 30_000;

const ResponseSchema = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.number(), z.string()]).nullish(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional()
});

const ToolsListSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.unknown().optional()
    })
  )
});

export type McpTool = { name: string; description?: string; inputSchema: unknown };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * Minimal JSON-RPC 2.0 MCP client: initialize handshake, tools/list, tools/call.
 * Correlates responses to requests by id. Transport-agnostic.
 */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly transport: Transport) {
    this.transport.setHandler((msg) => this.onMessage(msg));
  }

  private onMessage(msg: unknown): void {
    const parsed = ResponseSchema.safeParse(msg);
    if (!parsed.success || parsed.data.id == null) return; // notification or junk
    const id = Number(parsed.data.id);
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (parsed.data.error) entry.reject(new Error(parsed.data.error.message));
    else entry.resolve(parsed.data.result);
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ jsonrpc: '2.0', id, method, params }).catch((e: unknown) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send({ jsonrpc: '2.0', method, params });
  }

  async connect(): Promise<void> {
    await this.transport.start();
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Fleet', version: '1.0.0' }
    });
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpTool[]> {
    const result = ToolsListSchema.parse(await this.request('tools/list'));
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} }
    }));
  }

  /** Call a tool; returns the raw `result` (caller stringifies/budgets). */
  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args ?? {} });
  }

  async close(): Promise<void> {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('MCP client closed'));
    }
    this.pending.clear();
    await this.transport.close();
  }
}
