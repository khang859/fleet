import { z } from 'zod';
import type {
  McpServerConfig,
  McpServersConfig,
  McpServerStatus,
  McpConnectionState
} from '../../../shared/mcp-types';
import { namespacedToolName, transportOf } from '../../../shared/mcp-types';
import { McpClient, type McpTool } from './client';
import { StdioTransport, HttpTransport, type Transport } from './transport';
import { expandVars, expandArray, expandRecord } from './expand';

const MAX_RESULT_CHARS = 25_000;
const WARN_RESULT_CHARS = 10_000;

const CallResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  isError: z.boolean().optional()
});

type ServerEntry = {
  config: McpServerConfig;
  client: McpClient | null;
  tools: McpTool[];
  state: McpConnectionState;
  error?: string;
};

/**
 * Connects to configured MCP servers and exposes their tools to the chat loop.
 * Tool names are namespaced (`mcp__server__tool`); the manager owns the
 * authoritative name→(server,tool) map so routing is unambiguous.
 */
export class McpManager {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly toolRoute = new Map<string, { server: string; tool: string }>();

  constructor(
    private readonly getConfig: () => McpServersConfig,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  private makeTransport(cfg: McpServerConfig): Transport {
    if (cfg.url) {
      return new HttpTransport(expandVars(cfg.url, this.env), expandRecord(cfg.headers, this.env));
    }
    return new StdioTransport(
      expandVars(cfg.command ?? '', this.env),
      expandArray(cfg.args, this.env) ?? [],
      expandRecord(cfg.env, this.env)
    );
  }

  /** Disconnect everything and (re)connect all enabled servers. */
  async reload(): Promise<void> {
    await this.closeAll();
    const config = this.getConfig();
    for (const [name, cfg] of Object.entries(config)) {
      if (!cfg.enabled) {
        this.servers.set(name, { config: cfg, client: null, tools: [], state: 'disabled' });
        continue;
      }
      const client = new McpClient(this.makeTransport(cfg));
      try {
        await client.connect();
        const tools = await client.listTools();
        this.servers.set(name, { config: cfg, client, tools, state: 'connected' });
        for (const t of tools)
          this.toolRoute.set(namespacedToolName(name, t.name), {
            server: name,
            tool: t.name
          });
      } catch (err) {
        await client.close().catch(() => {});
        this.servers.set(name, {
          config: cfg,
          client: null,
          tools: [],
          state: 'failed',
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  /** OpenRouter function-tool defs for every connected server's tools. */
  getToolDefs(): unknown[] {
    const defs: unknown[] = [];
    for (const [name, entry] of this.servers) {
      if (entry.state !== 'connected') continue;
      for (const tool of entry.tools) {
        defs.push({
          type: 'function',
          function: {
            name: namespacedToolName(name, tool.name),
            description: tool.description ?? `MCP tool ${tool.name} from ${name}`,
            parameters: tool.inputSchema
          }
        });
      }
    }
    return defs;
  }

  hasTool(name: string): boolean {
    return this.toolRoute.has(name);
  }

  /** Call a namespaced MCP tool; returns budgeted text for the model. */
  async callTool(name: string, argsJson: string): Promise<string> {
    const route = this.toolRoute.get(name);
    if (!route) return `Unknown MCP tool: ${name}`;
    const entry = this.servers.get(route.server);
    if (!entry?.client) return `MCP server "${route.server}" is not connected.`;

    let args: unknown = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      return 'Invalid tool arguments (not JSON).';
    }
    const result = await entry.client.callTool(route.tool, args);
    return budgetResult(result);
  }

  statuses(): McpServerStatus[] {
    return [...this.servers.entries()].map(([name, entry]) => ({
      name,
      transport: transportOf(entry.config),
      state: entry.state,
      toolCount: entry.tools.length,
      error: entry.error,
      tools: entry.tools.map((t) => ({ name: t.name, description: t.description }))
    }));
  }

  async closeAll(): Promise<void> {
    for (const entry of this.servers.values()) await entry.client?.close().catch(() => {});
    this.servers.clear();
    this.toolRoute.clear();
  }
}

/** Flatten an MCP tools/call result to text and cap it to avoid context floods. */
export function budgetResult(result: unknown): string {
  const parsed = CallResultSchema.safeParse(result);
  let text: string;
  if (parsed.success && parsed.data.content) {
    text = parsed.data.content
      .map((c) => c.text ?? '')
      .filter(Boolean)
      .join('\n');
  } else {
    text = JSON.stringify(result);
  }
  if (text.length > MAX_RESULT_CHARS) {
    return `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated ${text.length - MAX_RESULT_CHARS} chars)`;
  }
  if (text.length > WARN_RESULT_CHARS) {
    return `${text}\n(note: large result, ${text.length} chars)`;
  }
  return text || '(no output)';
}
