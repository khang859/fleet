/**
 * `${VAR}` in a server's config, resolved against the environment.
 *
 * A config is worth sharing and a token is not, so the two are kept apart: the
 * config says which variable holds the secret, and the secret stays wherever
 * the user already keeps it. This is the convention Claude Code and the rest
 * settled on, which matters because the whole point of taking the standard
 * config shape is that a config pasted from somewhere else works.
 *
 * `${VAR:-default}` is supported for the same reason - a config that names a
 * port or a region should not fail to start on a machine that never set one.
 *
 * Shared by both MCP clients (Chat and Agent). It lives here rather than under
 * either one because a config pasted into Chat and the same config pasted into
 * Agent have to expand identically; they did not when each kept its own copy.
 */

/**
 * `${NAME}` or `${NAME:-fallback}`, with a leading `$` escaping the whole
 * thing. The fallback runs to the closing brace and may be empty, which is how
 * a config says "this one is genuinely optional".
 */
const REFERENCE = /(\$?)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** A variable named but never set, with no fallback to fall back to. */
export type MissingVar = string;

export type Expansion = {
  value: string;
  /** Names that resolved to nothing. Reported rather than silently blanked. */
  missing: MissingVar[];
};

/**
 * Expand one string, and say what was missing.
 *
 * An unset variable leaves its reference in the text rather than collapsing to
 * an empty string. Blanking it would turn a missing token into a request sent
 * with no token at all, and the failure that comes back from that says nothing
 * about the cause. Left in place, the server's own error names the variable.
 */
export function expand(input: string, env: NodeJS.ProcessEnv): Expansion {
  const missing: MissingVar[] = [];
  const value = input.replace(
    REFERENCE,
    (_full, escape: string, name: string, fallback: string | undefined) => {
      if (escape === '$') return `\${${name}}`;
      const found = env[name];
      if (found !== undefined) return found;
      if (fallback !== undefined) return fallback;
      missing.push(name);
      return `\${${name}}`;
    }
  );
  return { value, missing };
}

/** Expand a string, discarding the report. For callers that cannot act on it. */
export function expandVars(input: string, env: NodeJS.ProcessEnv): string {
  return expand(input, env).value;
}

export function expandArray(
  arr: string[] | undefined,
  env: NodeJS.ProcessEnv
): string[] | undefined {
  return arr?.map((s) => expandVars(s, env));
}

export function expandRecord(
  rec: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv
): Record<string, string> | undefined {
  if (rec === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = expandVars(v, env);
  return out;
}

/**
 * Every variable a config names but the environment does not have.
 *
 * Collected across the whole config rather than per field, because what the
 * user needs to be told is "set GITHUB_TOKEN", not which of four places it was
 * mentioned in.
 */
export function missingVars(
  parts: Array<string | string[] | Record<string, string> | undefined>,
  env: NodeJS.ProcessEnv
): MissingVar[] {
  const seen = new Set<MissingVar>();
  const walk = (s: string): void => {
    for (const name of expand(s, env).missing) seen.add(name);
  };
  for (const part of parts) {
    if (part === undefined) continue;
    if (typeof part === 'string') walk(part);
    else if (Array.isArray(part)) part.forEach(walk);
    else Object.values(part).forEach(walk);
  }
  return [...seen];
}
