import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type Transport
} from '@modelcontextprotocol/client';
import type { McpServerConfig } from '../../../shared/agent-mcp';
import { enrichProcessEnv } from '../../shell-env';
import { expandArray, expandRecord, expandVars } from './expand';

/**
 * How Fleet reaches one server.
 *
 * Two shapes, chosen by what the config carries: a `command` is a process to
 * spawn and talk to over its pipes, a `url` is an endpoint to POST to. The SDK
 * owns both, so what is left here is the part it cannot know - which
 * environment a spawned server should inherit, and what a `${VAR}` in the
 * config was standing in for.
 */

/**
 * Build a transport for one server.
 *
 * Async because a spawned server needs the user's real PATH, and on a packaged
 * app that has to be gone and fetched. A server started from Finder inherits
 * launchd's four directories, which contain no `npx`, no `uvx`, and none of the
 * runtimes anyone actually installs things with - so every stdio server in the
 * catalogue would fail with ENOENT, and only ever once the app was shipped.
 */
/** What a server needs to prove who we are, resolved by the caller. */
export type TransportAuth = {
  authProvider?: OAuthClientProvider;
  /** Headers holding a resolved secret, kept out of the stored config. */
  headers?: Record<string, string>;
};

export async function createTransport(
  cfg: McpServerConfig,
  auth?: TransportAuth
): Promise<Transport> {
  if (cfg.url !== undefined && cfg.url !== '') {
    return httpTransport(cfg, auth);
  }
  return stdioTransport(cfg);
}

async function stdioTransport(cfg: McpServerConfig): Promise<Transport> {
  // Idempotent, and awaited rather than assumed: the app kicks this off at
  // startup without waiting, so the first server to connect may well get here
  // before it has finished.
  await enrichProcessEnv();

  const env = process.env;
  const command = expandVars(cfg.command ?? '', env);
  if (command === '') {
    throw new Error('This server has neither a command to run nor a URL to call.');
  }

  return new StdioClientTransport({
    command,
    args: expandArray(cfg.args, env) ?? [],
    // The enriched process env underneath, so a server inherits the shell the
    // user actually has, with its own settings layered on top.
    env: { ...stringOnly(process.env), ...(expandRecord(cfg.env, env) ?? {}) },
    // Captured rather than inherited: a server that chatters on stderr would
    // otherwise write over Fleet's own log, and a server that dies has its
    // reason there. The manager reads it to explain a failure.
    stderr: 'pipe'
  });
}

/**
 * The HTTP transport, concretely.
 *
 * Exported with its real type rather than as a `Transport` because signing in
 * needs `finishAuth`, which only this one has - a spawned process has no
 * redirect to come back from.
 */
export function httpTransport(
  cfg: McpServerConfig,
  auth?: TransportAuth
): StreamableHTTPClientTransport {
  const env = process.env;
  const url = new URL(expandVars(cfg.url ?? '', env));
  const headers = {
    ...(expandRecord(cfg.headers, env) ?? {}),
    ...(auth?.headers ?? {})
  };

  return new StreamableHTTPClientTransport(url, {
    requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    // Undefined when the server does not use OAuth, which the SDK reads as
    // "send what headers you were given and do not try to authenticate".
    authProvider: auth?.authProvider
  });
}

/**
 * `process.env` as a plain string map.
 *
 * Node types every value as possibly undefined, and a spawn wants neither the
 * key nor a literal "undefined" for one that is unset.
 */
function stringOnly(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
