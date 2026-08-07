import { z } from 'zod';

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
   * The key it had in that file.
   *
   * Kept because Fleet's own name can drift - the user renames it, or two tools
   * both called theirs `context7` and one had to be qualified - and a re-scan
   * still has to be able to find the row this server was copied into.
   */
  sourceName: string;
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

/**
 * Every configured server, by the name the user gave it.
 *
 * `| undefined` on the value because looking up a name that is not there is
 * ordinary - a row the user just deleted, a name typed into a rule - and the
 * code that does it should have to say what it means to happen.
 */
export type McpServersConfig = Record<string, McpServerConfig | undefined>;

/**
 * What stands in a stored config where a secret used to be.
 *
 * A header or environment value that looks like a credential is lifted into the
 * secret store on the way in, and this is left behind so the settings file still
 * says the field exists. Deliberately shaped like the `${VAR}` references the
 * config already understands, and deliberately not one: nothing expands it, and
 * a value still reading this at connect time is dropped rather than sent.
 */
export const MCP_SECRET_REF = '${fleet:secret}';

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

/**
 * Everything the settings pane holds, in one answer.
 *
 * Every call that changes something answers with this, so the pane never has to
 * ask a second time to find out what its own click did - and cannot end up
 * showing a config that has been saved beside a status from before it was.
 */
export type McpSnapshot = {
  servers: McpServersConfig;
  statuses: McpServerStatus[];
  /**
   * Which servers have a credential stored.
   *
   * The value itself never leaves main, so this is all the pane can know - and
   * all it needs, because the only question it asks is whether to draw "Sign
   * in" or "Sign out".
   */
  credentials: Record<string, boolean>;
};

/** One server found in another tool's config, and whether we already have it. */
export type McpDetectedServer = {
  name: string;
  config: McpServerConfig;
  origin: McpImportOrigin;
  /** `known` means imported already and unchanged since. */
  status: 'new' | 'changed' | 'known';
};

/**
 * What a server said, before it becomes a tool result.
 *
 * A picture comes back beside the text rather than inside it, because a tool
 * result on the wire may only be text - the same reason `read` hands a
 * screenshot back on a message of its own. Only the first one: a tool that
 * returns a gallery is returning something for a person to scroll, and sending
 * all of it would cost more context than the answer is worth.
 */
export type McpToolOutput = {
  text: string;
  /** True when the server reported the call itself as a failure. */
  isError: boolean;
  /** Base64, exactly as the server sent it. */
  image: { data: string; mimeType: string } | null;
};

/**
 * The same shape, checked at runtime.
 *
 * Everything here arrives from the renderer, and a config becomes a process to
 * spawn or a URL to POST to. Types say nothing at the boundary, so the boundary
 * checks - and a field that does not belong is dropped rather than carried
 * through to a spawn.
 */
const StringMap = z.record(z.string(), z.string());

export const McpAuthSchema: z.ZodType<McpAuth> = z.object({
  kind: z.enum(['none', 'bearer', 'oauth'])
});

export const McpImportOriginSchema: z.ZodType<McpImportOrigin> = z.object({
  source: z.enum(['claude-code', 'opencode']),
  scope: z.enum(['user', 'project']),
  path: z.string(),
  sourceName: z.string(),
  fingerprint: z.string()
});

export const McpServerConfigSchema: z.ZodType<McpServerConfig> = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: StringMap.optional(),
  url: z.string().optional(),
  headers: StringMap.optional(),
  enabled: z.boolean(),
  auth: McpAuthSchema.optional(),
  disabledTools: z.array(z.string()).optional(),
  importedFrom: McpImportOriginSchema.optional()
});

export const McpServersConfigSchema: z.ZodType<McpServersConfig> = z.record(
  z.string(),
  McpServerConfigSchema
);

export function transportOf(cfg: McpServerConfig): McpTransportKind {
  return cfg.url !== undefined && cfg.url !== '' ? 'http' : 'stdio';
}

/** Whether a config carries enough to connect at all. */
export function isConnectable(cfg: McpServerConfig): boolean {
  return (cfg.url ?? '') !== '' || (cfg.command ?? '') !== '';
}
