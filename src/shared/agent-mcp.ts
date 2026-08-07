/**
 * MCP servers the Agent pane connects to.
 *
 * Deliberately separate from `mcp-types.ts`, which is Chat's. The two panes
 * keep their own server lists and their own connections: the Agent pane is a
 * from-scratch build, and a shared config would mean one pane's settings
 * silently changing what the other can do.
 *
 * The config shape follows the standard `mcpServers` blob so a config lifted
 * out of a README pastes in unchanged, with `enabled` added because a server
 * worth keeping is not always a server worth connecting to right now.
 */

/** Where a server's config came from, kept so a re-scan can tell new from known. */
export type McpImportSource = 'claude-code' | 'opencode';

/** Which config file within a source, since both tools have more than one. */
export type McpImportScope = 'user' | 'project';

export type McpImportOrigin = {
  source: McpImportSource;
  scope: McpImportScope;
  /** Absolute path of the file it was read from, so the UI can point at it. */
  path: string;
  /**
   * A digest of the normalised config as it stood when imported. A re-scan
   * compares against this to tell "already have it" from "it changed since".
   */
  fingerprint: string;
};

/** How a server proves who we are. */
export type McpAuth =
  | { kind: 'none' }
  /** A static token. The value lives in the secret store, never in settings. */
  | { kind: 'bearer' }
  /** OAuth 2.1. Tokens and client registration live in the secret store. */
  | { kind: 'oauth' };

/** One server entry. `command` means stdio; `url` means Streamable HTTP. */
export type McpServerConfig = {
  /** stdio: the executable to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: the server's endpoint. */
  url?: string;
  headers?: Record<string, string>;
  /** A disabled server keeps its config and contributes no tools. */
  enabled: boolean;
  auth?: McpAuth;
  /**
   * Tools the user has switched off, by their name on the server rather than
   * their wire name. The server's own names are what the settings list shows,
   * and they do not change when a wire name gets shortened.
   */
  disabledTools?: string[];
  importedFrom?: McpImportOrigin;
};

export type McpServersConfig = Record<string, McpServerConfig>;

export type McpTransportKind = 'stdio' | 'http';

/**
 * What a server is doing.
 *
 * `needs-auth` is deliberately not `failed`. A server that wants a sign-in has
 * nothing wrong with it, and showing it as broken would send the user looking
 * for a fault instead of clicking the button that fixes it.
 */
export type McpConnectionState = 'connected' | 'connecting' | 'needs-auth' | 'failed' | 'disabled';

export type McpToolSummary = {
  name: string;
  description?: string;
  /** The wire name this tool is offered under, which may be shortened. */
  wireName: string;
  /** False when the user has switched this one off. */
  enabled: boolean;
  /** The server's own claim that the tool only reads. A convenience, not a guarantee. */
  readOnly: boolean;
};

/** Per-server status, as the settings list draws it. */
export type McpServerStatus = {
  name: string;
  transport: McpTransportKind;
  state: McpConnectionState;
  /** Tools currently offered to the model, so disabled ones do not count. */
  toolCount: number;
  error?: string;
  tools: McpToolSummary[];
};

/** One server found in another tool's config, and whether we already have it. */
export type McpDetectedServer = {
  name: string;
  config: McpServerConfig;
  origin: McpImportOrigin;
  /** `known` means imported already and unchanged since. */
  status: 'new' | 'changed' | 'known';
};

export function transportOf(cfg: McpServerConfig): McpTransportKind {
  return cfg.url !== undefined && cfg.url !== '' ? 'http' : 'stdio';
}

/** Whether a config carries enough to connect at all. */
export function isConnectable(cfg: McpServerConfig): boolean {
  return (cfg.url ?? '') !== '' || (cfg.command ?? '') !== '';
}
