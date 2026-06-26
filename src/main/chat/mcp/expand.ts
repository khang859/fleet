/**
 * Expand `${VAR}` references against an environment map so MCP configs can be
 * committed without secrets (the secret lives in the user's env). Unknown vars
 * expand to empty string. Escaped `$${VAR}` is left literal as `${VAR}`.
 */
export function expandVars(input: string, env: NodeJS.ProcessEnv): string {
  return input.replace(
    /(\$?)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_full, esc: string, name: string) => (esc === '$' ? `\${${name}}` : (env[name] ?? ''))
  );
}

/** Deep-expand `${VAR}` across all string values of a record. */
export function expandRecord(
  rec: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv
): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = expandVars(v, env);
  return out;
}

export function expandArray(
  arr: string[] | undefined,
  env: NodeJS.ProcessEnv
): string[] | undefined {
  return arr?.map((s) => expandVars(s, env));
}
