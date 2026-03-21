export function normalizeRuntimeEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      normalized[key] = value;
    }
  }

  return normalized;
}
