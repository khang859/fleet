/**
 * Return a copy of process.env with undefined values stripped out.
 * Useful when an API requires Record<string, string> instead of NodeJS.ProcessEnv.
 */
export function filterEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] != null,
    ),
  );
}
