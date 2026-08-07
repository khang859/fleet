import { z } from 'zod';
import type { McpServerConfig } from '../../../../../../shared/agent-mcp';

/**
 * Turning what someone typed into a server config, and back.
 *
 * Kept out of the dialog because this is where the mistakes are: a pasted blob
 * from a README, an environment line with an `=` in the value, a config that is
 * valid JSON and not a server. All of it is worth testing without a form.
 */

/** `KEY=value` per line, for environment. Only the first `=` separates. */
export function parseEnv(text: string): Record<string, string> {
  return parsePairs(text, '=');
}

/** `Name: value` per line, for HTTP headers. Only the first `:` separates. */
export function parseHeaders(text: string): Record<string, string> {
  return parsePairs(text, ':');
}

function parsePairs(text: string, separator: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf(separator);
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    // Not trimmed further than the separator: a header value may legitimately
    // start with something that looks like padding, and a token never should
    // lose characters on the way in.
    const value = trimmed.slice(at + 1).trim();
    if (key !== '') out[key] = value;
  }
  return out;
}

export function formatEnv(env: Record<string, string> | undefined): string {
  return format(env, '=');
}

export function formatHeaders(headers: Record<string, string> | undefined): string {
  return format(headers, ': ');
}

function format(pairs: Record<string, string> | undefined, separator: string): string {
  if (pairs === undefined) return '';
  return Object.entries(pairs)
    .map(([key, value]) => `${key}${separator}${value}`)
    .join('\n');
}

/**
 * One argument per line.
 *
 * Deliberately not shell splitting: an argument with a space in it is ordinary
 * (`--filter=my project`), and a quoting parser would be one more thing between
 * what the user typed and what gets spawned.
 */
export function parseArgs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * What a pasted config may look like.
 *
 * Loose on purpose. Configs are copied out of other tools' READMEs, so they
 * arrive with `type`, `disabled`, `timeout` and whatever else that tool added -
 * none of which Fleet uses, and none of which is a reason to refuse the paste.
 */
const PastedServer = z.looseObject({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Both spellings are in the wild; either one off means off. */
  enabled: z.boolean().optional(),
  disabled: z.boolean().optional()
});

const PastedServers = z.record(z.string(), PastedServer);
const Wrapped = z.object({ mcpServers: PastedServers });

export type PasteResult =
  | { ok: true; servers: Record<string, McpServerConfig> }
  | { ok: false; error: string };

/**
 * Read a pasted blob as a set of servers.
 *
 * Accepts both the wrapped `{"mcpServers": {…}}` form every tool documents and
 * a bare map of servers, because both are what ends up on the clipboard - the
 * first from a README, the second from someone's existing config file.
 */
export function parsePasted(text: string): PasteResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: 'Nothing to read yet.' };

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'That is not valid JSON.' };
  }

  // The wrapped form is tried first because it also satisfies the bare one -
  // `mcpServers` is an object, and every field of a server is optional.
  const wrapped = Wrapped.safeParse(json);
  const bare = wrapped.success ? null : PastedServers.safeParse(json);
  const entries = wrapped.success
    ? wrapped.data.mcpServers
    : bare?.success === true
      ? bare.data
      : null;
  if (entries === null) {
    return { ok: false, error: 'That JSON does not describe any MCP servers.' };
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(entries)) {
    const url = entry.url ?? '';
    const command = entry.command ?? '';
    // A server that is neither a URL nor a command cannot be connected to, and
    // silently keeping it would put a permanently broken row in the list.
    if (url === '' && command === '') continue;
    servers[name] = {
      ...(command === '' ? {} : { command, args: entry.args, env: entry.env }),
      ...(url === '' ? {} : { url, headers: entry.headers }),
      enabled: entry.enabled ?? !(entry.disabled ?? false)
    };
  }

  if (Object.keys(servers).length === 0) {
    return { ok: false, error: 'No server in there had a command or a URL.' };
  }
  return { ok: true, servers };
}
