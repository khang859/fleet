import { Client, UnauthorizedError, type Tool, type Transport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import type {
  McpServerConfig,
  McpServersConfig,
  McpServerStatus,
  McpConnectionState,
  McpToolSummary,
  McpToolOutput
} from '../../../shared/agent-mcp';
import { transportOf, isConnectable } from '../../../shared/agent-mcp';
import type { ExternalToolSpec } from '../../../shared/agent-tools';
import { wireToolName } from '../../../shared/agent-mcp-names';
import { createTransport, type TransportAuth } from './transport';
import { createLogger } from '../../logger';

const log = createLogger('agent-mcp');

/**
 * The most text one tool result may put into the conversation.
 *
 * A server is under no obligation to be brief, and a tool that returns a whole
 * file or a thousand-row table would spend the context the rest of the turn
 * needs. Truncating loses the tail of one answer; not truncating loses the
 * conversation.
 */
const MAX_RESULT_CHARS = 25_000;

/** Past this, the result is kept whole but the model is told it was large. */
const WARN_RESULT_CHARS = 10_000;

/**
 * How long a server gets to finish connecting.
 *
 * Short on purpose. This runs while the user is waiting to type, and a server
 * that is slow to start is indistinguishable from one that is never going to:
 * either way the pane should open. A server that misses it is reported as
 * failed and can be reconnected by hand.
 */
const CONNECT_TIMEOUT_MS = 5_000;

type ServerEntry = {
  config: McpServerConfig;
  client: Client | null;
  tools: Tool[];
  state: McpConnectionState;
  error?: string;
};

type Route = { server: string; tool: string };

export type ManagerDeps = {
  getConfig: () => McpServersConfig;
  /** Resolves stored secrets and OAuth for one server. Absent in tests. */
  getAuth?: (
    name: string,
    cfg: McpServerConfig
  ) => TransportAuth | undefined | Promise<TransportAuth | undefined>;
  /** Runs an interactive sign-in. Absent in tests, and on a build with no window. */
  signIn?: (name: string, cfg: McpServerConfig, signal?: AbortSignal) => Promise<void>;
  /** Lets the pane redraw when a server's tools or state change underneath it. */
  onStatusChange?: (statuses: McpServerStatus[]) => void;
  /** Swapped in tests. Real callers get the SDK transports. */
  createTransport?: (cfg: McpServerConfig, auth?: TransportAuth) => Transport | Promise<Transport>;
};

/**
 * Every MCP server the Agent pane is talking to.
 *
 * Owns the one thing that has to be authoritative: the map from the name a
 * tool is offered to the model under to the server and tool it actually means.
 * Wire names get shortened when they are too long, so the name the model sends
 * back is not always something you can read the route out of - which is fine
 * as long as exactly one place is doing the remembering.
 */
export class McpManager {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly routes = new Map<string, Route>();

  constructor(private readonly deps: ManagerDeps) {}

  /** Drop every connection and rebuild from the current config. */
  async reload(): Promise<void> {
    await this.closeAll();
    const config = this.deps.getConfig();
    // Connected in parallel: one slow server should not hold up the rest, and
    // each has its own timeout, so the whole reload is bounded by the slowest
    // single connect rather than by their sum.
    await Promise.all(
      Object.entries(config).map(async ([name, cfg]) =>
        cfg === undefined ? undefined : this.connectOne(name, cfg)
      )
    );
    this.announce();
  }

  private async connectOne(name: string, cfg: McpServerConfig): Promise<void> {
    if (!cfg.enabled) {
      this.servers.set(name, { config: cfg, client: null, tools: [], state: 'disabled' });
      return;
    }
    if (!isConnectable(cfg)) {
      this.setFailed(name, cfg, 'This server has neither a command to run nor a URL to call.');
      return;
    }

    const client = new Client(
      { name: 'Fleet', version: '1.0.0' },
      { listChanged: { tools: { onChanged: this.onToolsChanged(name) } } }
    );
    try {
      const auth = await this.deps.getAuth?.(name, cfg);
      const makeTransport = this.deps.createTransport ?? createTransport;
      const transport = await makeTransport(cfg, auth);

      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'connect');
      const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'list tools');

      this.servers.set(name, { config: cfg, client, tools, state: 'connected' });
      this.mapRoutes(name, tools);
    } catch (err) {
      await client.close().catch(() => {});
      // A server asking to be signed in has nothing wrong with it, so it is not
      // reported as broken. The pane offers a button instead of an error.
      if (err instanceof UnauthorizedError) {
        this.servers.set(name, { config: cfg, client: null, tools: [], state: 'needs-auth' });
        return;
      }
      this.setFailed(name, cfg, messageOf(err));
    }
  }

  private setFailed(name: string, config: McpServerConfig, error: string): void {
    log.warn('MCP server failed to connect', { server: name, error });
    this.servers.set(name, { config, client: null, tools: [], state: 'failed', error });
  }

  /**
   * Record how to get back to each tool.
   *
   * Only enabled tools are routed. A call to one the user switched off should
   * come back as an unknown tool rather than quietly running, because the model
   * was never offered it and reaching it means something has gone wrong.
   */
  private mapRoutes(name: string, tools: Tool[]): void {
    const disabled = new Set(this.servers.get(name)?.config.disabledTools ?? []);
    for (const tool of tools) {
      if (disabled.has(tool.name)) continue;
      this.routes.set(wireToolName(name, tool.name), { server: name, tool: tool.name });
    }
  }

  /**
   * Follow a server that changes its own tool list.
   *
   * Servers that front something live - a database, a deploy target - add and
   * drop tools as that thing changes, and a list fetched once at startup would
   * quietly drift out of date. The SDK does the listening: it opens a
   * subscription where the protocol has one and falls back to the older
   * unsolicited notification where it does not, debounces, and re-lists, so
   * what arrives here is the new list either way.
   */
  private onToolsChanged(name: string): (error: Error | null, tools: Tool[] | null) => void {
    return (error, tools) => {
      if (error !== null || tools === null) {
        log.warn('failed to refresh tools', { server: name, error: error?.message });
        return;
      }
      const entry = this.servers.get(name);
      if (entry === undefined) return; // superseded by a reload
      entry.tools = tools;
      this.clearRoutesFor(name);
      this.mapRoutes(name, tools);
      this.announce();
    };
  }

  private clearRoutesFor(server: string): void {
    for (const [wire, route] of [...this.routes]) {
      if (route.server === server) this.routes.delete(wire);
    }
  }

  /** What the model is offered, across every connected server. */
  getToolSpecs(): ExternalToolSpec[] {
    const specs: ExternalToolSpec[] = [];
    for (const [name, entry] of this.servers) {
      if (entry.state !== 'connected') continue;
      const disabled = new Set(entry.config.disabledTools ?? []);
      for (const tool of entry.tools) {
        if (disabled.has(tool.name)) continue;
        specs.push({
          type: 'function',
          function: {
            name: wireToolName(name, tool.name),
            description: tool.description ?? `${tool.name}, from the ${name} server.`,
            parameters: asParameters(tool.inputSchema)
          }
        });
      }
    }
    return specs;
  }

  hasTool(wire: string): boolean {
    return this.routes.has(wire);
  }

  /** Whether the server says this tool only reads. Its claim, not a guarantee. */
  isReadOnly(wire: string): boolean {
    const route = this.routes.get(wire);
    if (route === undefined) return false;
    const tool = this.servers.get(route.server)?.tools.find((t) => t.name === route.tool);
    return tool?.annotations?.readOnlyHint === true;
  }

  /** The server a wire name belongs to, for labelling a row. */
  serverOf(wire: string): string | null {
    return this.routes.get(wire)?.server ?? null;
  }

  /** The tool's own name, which is what the user configured and sees. */
  toolOf(wire: string): string | null {
    return this.routes.get(wire)?.tool ?? null;
  }

  /**
   * Run one call and return what the model should read.
   *
   * Everything that can go wrong is returned as a sentence rather than thrown:
   * a server that is down or a tool that errored is something the model can
   * work around, and ending the turn over it would throw away the rest.
   */
  async callTool(wire: string, argsJson: string): Promise<McpToolOutput> {
    const route = this.routes.get(wire);
    if (route === undefined)
      return { text: `There is no tool called ${wire}`, isError: true, image: null };

    const entry = this.servers.get(route.server);
    if (entry?.client == null) {
      return { text: `The ${route.server} server is not connected.`, isError: true, image: null };
    }

    let args: Record<string, unknown> = {};
    if (argsJson.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(argsJson);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = { ...parsed };
        } else {
          return {
            text: `The arguments for ${wire} were not a JSON object.`,
            isError: true,
            image: null
          };
        }
      } catch {
        return {
          text: `The arguments for ${wire} were not valid JSON: ${argsJson}`,
          isError: true,
          image: null
        };
      }
    }

    try {
      const result = await entry.client.callTool({ name: route.tool, arguments: args });
      return readResult(result);
    } catch (err) {
      return { text: messageOf(err), isError: true, image: null };
    }
  }

  /**
   * Sign in to one server, then connect it.
   *
   * Reconnecting is part of signing in rather than something the caller has to
   * remember: the point of signing in is to have the server's tools, and a
   * server that says "signed in" while still showing none of them is a button
   * that appears not to have worked.
   */
  async signIn(name: string, signal?: AbortSignal): Promise<void> {
    const cfg = this.deps.getConfig()[name];
    if (cfg === undefined) throw new Error(`There is no server called ${name}.`);
    if (this.deps.signIn === undefined) {
      throw new Error('Signing in is not available in this build.');
    }

    // Dropped first: the connection that could not authorize is holding the
    // old credentials, and reconnecting over it would use them again.
    await this.disconnect(name);
    await this.deps.signIn(name, cfg, signal);
    await this.connectOne(name, cfg);
    this.announce();
  }

  /** Drop one server and reconnect it, for a config the user just changed. */
  async reconnect(name: string): Promise<void> {
    const cfg = this.deps.getConfig()[name];
    await this.disconnect(name);
    if (cfg !== undefined) await this.connectOne(name, cfg);
    this.announce();
  }

  private async disconnect(name: string): Promise<void> {
    await this.servers
      .get(name)
      ?.client?.close()
      .catch(() => {});
    this.servers.delete(name);
    this.clearRoutesFor(name);
  }

  statuses(): McpServerStatus[] {
    return [...this.servers.entries()].map(([name, entry]) => {
      const disabled = new Set(entry.config.disabledTools ?? []);
      const tools: McpToolSummary[] = entry.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        wireName: wireToolName(name, tool.name),
        enabled: !disabled.has(tool.name),
        readOnly: tool.annotations?.readOnlyHint === true
      }));
      return {
        name,
        transport: transportOf(entry.config),
        state: entry.state,
        toolCount: tools.filter((t) => t.enabled).length,
        error: entry.error,
        tools
      };
    });
  }

  private announce(): void {
    this.deps.onStatusChange?.(this.statuses());
  }

  async closeAll(): Promise<void> {
    for (const entry of this.servers.values()) {
      await entry.client?.close().catch(() => {});
    }
    this.servers.clear();
    this.routes.clear();
  }
}

/**
 * An MCP result, flattened to what a tool-result message can carry.
 *
 * The wire allows a list of blocks of several kinds; a tool result may only be
 * text. Text blocks are joined and a picture is lifted out to travel beside
 * them. Anything else is named rather than dropped, so a model that gets back
 * an audio clip at least knows one arrived.
 */
export function readResult(result: unknown): McpToolOutput {
  const parsed = ToolResultShape.safeParse(result);
  if (!parsed.success || parsed.data.content === undefined) {
    // Not a shape we know how to read. Handed over verbatim rather than
    // discarded: a server that answers in its own dialect is still answering.
    const verbatim = result === undefined ? '(no output)' : JSON.stringify(result);
    return { text: budget(verbatim), isError: parsed.data?.isError ?? false, image: null };
  }

  const parts: string[] = [];
  let image: McpToolOutput['image'] = null;
  for (const block of parsed.data.content) {
    if (block.type === 'image' && block.data !== undefined && block.mimeType !== undefined) {
      image ??= { data: block.data, mimeType: block.mimeType };
      continue;
    }
    const part = block.text ?? (block.type === undefined ? '' : `(${block.type} content)`);
    if (part !== '') parts.push(part);
  }

  const text = budget(parts.join('\n'));
  return {
    text: text === '' ? (image === null ? '(no output)' : '(an image)') : text,
    isError: parsed.data.isError,
    image
  };
}

/**
 * As much of a tool result as reading it needs.
 *
 * Deliberately loose: a block whose `text` is not a string is not worth failing
 * the whole result over, so each field falls back on its own rather than
 * sinking the parse.
 */
const ToolResultShape = z.object({
  isError: z.boolean().catch(false),
  content: z
    .array(
      z.object({
        type: z.string().optional().catch(undefined),
        text: z.string().optional().catch(undefined),
        data: z.string().optional().catch(undefined),
        mimeType: z.string().optional().catch(undefined)
      })
    )
    .optional()
    .catch(undefined)
});

function budget(text: string): string {
  if (text.length > MAX_RESULT_CHARS) {
    return `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated ${text.length - MAX_RESULT_CHARS} characters)`;
  }
  if (text.length > WARN_RESULT_CHARS) {
    return `${text}\n(note: a large result, ${text.length} characters)`;
  }
  return text;
}

/**
 * A tool's input schema as the completions API wants it.
 *
 * A server that sends something unusable gets an empty object rather than a
 * malformed request: the tool is then callable with no arguments, which is
 * wrong but recoverable, where a rejected request would take the whole turn.
 */
function asParameters(schema: unknown): Record<string, unknown> {
  if (schema !== null && typeof schema === 'object' && !Array.isArray(schema)) {
    return { ...schema };
  }
  return { type: 'object', properties: {} };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out trying to ${what}.`)), ms);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
