import type { EnvSource, ShellEnvSnapshot, ShellEnvVar } from './shell-env-types';

/**
 * Build an immutable spawn-time env snapshot from the resolved env map plus a
 * per-key source map. Any key not in `sources` is `login-shell`; `FLEET_SESSION`
 * is always `fleet-builtin` (Fleet adds it unconditionally at spawn).
 */
export function buildEnvSnapshot(params: {
  finalEnv: Record<string, string | undefined>;
  sources: Record<string, EnvSource>;
  shellName: string;
  cwd: string;
  spawnedAt: number;
}): ShellEnvSnapshot {
  const { finalEnv, sources, shellName, cwd, spawnedAt } = params;

  const vars: ShellEnvVar[] = Object.entries(finalEnv)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => ({
      key,
      value,
      source: key === 'FLEET_SESSION' ? 'fleet-builtin' : (sources[key] ?? 'login-shell')
    }));

  vars.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { spawnedAt, shellName, cwd, vars };
}
