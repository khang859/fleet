import type { McpServerConfig } from '../../../../shared/agent-mcp';
import { MCP_SECRET_REF } from '../../../../shared/agent-mcp';
import type { AgentMcpSecrets } from '../secrets';

/**
 * Getting the credentials out of a config before it is stored.
 *
 * The files Fleet imports from keep API keys in the clear, because that is what
 * the tools that wrote them do. Copying a config in as it stands would put those
 * keys into `fleet-settings.json` - a plain-text file people open to check a
 * setting and paste into issues. So anything that looks like a credential is
 * moved into the encrypted store on the way in, and the config keeps only the
 * field name and a marker.
 *
 * A value already written as `${VAR}` is left exactly as it is. It is not a
 * secret, it is a reference to one, and rewriting it would break the indirection
 * the user set up on purpose.
 */

/** Key names that mean a credential whatever the value looks like. */
const CREDENTIAL_NAME = /key|token|secret|auth|password|passwd|credential/i;

/**
 * A value that reads like a credential on its own.
 *
 * Long, unbroken, and made of the characters tokens are made of. Deliberately
 * conservative: a path, a URL, a version number or a sentence all fail it, and
 * the cost of missing one is a value the user can still clear by hand.
 */
const CREDENTIAL_VALUE = /^[A-Za-z0-9_\-.]{24,}$/;

/** Anything the config already resolves at connect time. */
const REFERENCE = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Move a config's secrets into the store and hand back what to persist.
 *
 * An `Authorization: Bearer …` header becomes Fleet's own bearer auth rather
 * than a lifted field, because that is what it is - and a server that shows
 * "Bearer token" with a Change button says more than one showing a header the
 * user cannot read.
 */
export function liftSecrets(
  name: string,
  config: McpServerConfig,
  secrets: AgentMcpSecrets
): McpServerConfig {
  const out: McpServerConfig = { ...config };

  const bearer = bearerToken(config.headers);
  if (bearer !== null) {
    secrets.setToken(name, bearer.token);
    out.auth = { kind: 'bearer' };
    out.headers = without(config.headers, bearer.header);
  }

  out.headers = lift(name, 'headers', out.headers, secrets);
  out.env = lift(name, 'env', out.env, secrets);

  return out;
}

/**
 * The same walk, without writing anything.
 *
 * What the import dialog is shown. A detection crosses to the renderer before
 * the user has agreed to anything, and a credential belonging to another tool
 * has no business being over there at all.
 */
export function maskSecrets(config: McpServerConfig): McpServerConfig {
  const bearer = bearerToken(config.headers);
  const headers = bearer === null ? config.headers : without(config.headers, bearer.header);

  return {
    ...config,
    auth: bearer === null ? config.auth : { kind: 'bearer' },
    headers: mask(headers),
    env: mask(config.env)
  };
}

function lift(
  name: string,
  kind: 'headers' | 'env',
  values: Record<string, string> | undefined,
  secrets: AgentMcpSecrets
): Record<string, string> | undefined {
  if (values === undefined) return undefined;

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!isSecret(key, value)) {
      out[key] = value;
      continue;
    }
    secrets.setField(name, `${kind}.${key}`, value);
    out[key] = MCP_SECRET_REF;
  }
  return out;
}

function mask(values: Record<string, string> | undefined): Record<string, string> | undefined {
  if (values === undefined) return undefined;

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = isSecret(key, value) ? MCP_SECRET_REF : value;
  }
  return out;
}

export function isSecret(key: string, value: string): boolean {
  if (value === '' || value === MCP_SECRET_REF) return false;
  if (REFERENCE.test(value)) return false;
  return CREDENTIAL_NAME.test(key) || CREDENTIAL_VALUE.test(value);
}

/** The one header Fleet has a first-class place for. */
function bearerToken(
  headers: Record<string, string> | undefined
): { header: string; token: string } | null {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== 'authorization') continue;
    const token = /^Bearer\s+(.+)$/i.exec(value)?.[1];
    // A reference is left where it is: it resolves at connect time from an
    // environment Fleet does not own, and moving it would break that.
    if (token === undefined || REFERENCE.test(token)) return null;
    return { header: key, token };
  }
  return null;
}

function without(
  headers: Record<string, string> | undefined,
  key: string
): Record<string, string> | undefined {
  const rest = { ...headers };
  delete rest[key];
  return Object.keys(rest).length > 0 ? rest : undefined;
}
