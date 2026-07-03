/** Where a spawned shell's environment variable came from. */
export type EnvSource = 'login-shell' | 'env-sync' | 'fleet-builtin';

/** A single environment variable in a spawn-time snapshot. */
export type ShellEnvVar = {
  key: string;
  value: string;
  source: EnvSource;
};

/** Immutable snapshot of the env Fleet injected into a terminal at spawn time. */
export type ShellEnvSnapshot = {
  /** Epoch ms when the PTY was spawned. */
  spawnedAt: number;
  /** Shell binary name, e.g. "zsh". */
  shellName: string;
  /** Working directory the shell spawned in. */
  cwd: string;
  /** Variables, sorted ascending by key. */
  vars: ShellEnvVar[];
};
