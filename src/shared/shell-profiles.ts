// src/shared/shell-profiles.ts

/**
 * Identifies which filesystem semantics a path/process operates under.
 * - 'posix'        — macOS, Linux native
 * - 'win32'        — Windows native (PowerShell, cmd, Git Bash on Windows)
 * - { kind: 'wsl', distro } — inside a WSL distribution
 */
export type PathContext = 'posix' | 'win32' | { kind: 'wsl'; distro: string };

export type WslDistroState = 'running' | 'stopped' | 'installing' | 'error';

export type WslDistro = {
  name: string; // e.g. 'Ubuntu-22.04'
  version: 1 | 2;
  isDefault: boolean;
  state: WslDistroState;
};

export type ShellProfileKind = 'system' | 'wsl';

export type ShellProfile = {
  /** Stable id, e.g. 'windows.powershell', 'wsl.Ubuntu-22.04', 'posix.zsh'. */
  id: string;
  kind: ShellProfileKind;
  /** Human label for pickers, e.g. 'PowerShell', 'Ubuntu (WSL)', 'zsh'. */
  label: string;
  /** Absolute path or bare name resolvable via PATH. */
  command: string;
  args: string[];
  pathContext: PathContext;
  icon?: string;
};

/** Sentinel profile id used by legacy persisted layouts before this feature shipped. */
export const LEGACY_SYSTEM_DEFAULT_ID = 'legacy.system-default';
