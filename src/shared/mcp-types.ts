// Native MCP (Model Context Protocol) client types. Fleet historically only
// exposed MCP *servers*; Chat adds a *client* so users can attach external MCP
// servers and use their tools. We adopt the standard `mcpServers` config blob
// verbatim so users can paste configs from READMEs.

/** One server entry. `command` → stdio transport; `url` → Streamable HTTP. */
export type McpServerConfig = {
  /** stdio: executable to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: server URL. */
  url?: string;
  headers?: Record<string, string>;
  /** Disabled servers keep their config but contribute no tools. */
  enabled: boolean;
};

/** The standard pasteable blob: `{ "mcpServers": { name: {...} } }`. */
export type McpServersConfig = Record<string, McpServerConfig>;

export type McpTransportKind = 'stdio' | 'http';

export type McpConnectionState = 'connected' | 'connecting' | 'failed' | 'disabled';

export type McpToolSummary = { name: string; description?: string };

/** Per-server status surfaced in settings. */
export type McpServerStatus = {
  name: string;
  transport: McpTransportKind;
  state: McpConnectionState;
  toolCount: number;
  error?: string;
  tools: McpToolSummary[];
};

export function transportOf(cfg: McpServerConfig): McpTransportKind {
  return cfg.url ? 'http' : 'stdio';
}

/**
 * Namespace a server tool so calls route back unambiguously. The manager keeps
 * the authoritative name→(server,tool) map, so server names may contain any
 * characters; this is only the wire name shown to the model.
 */
export function namespacedToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__');
}
