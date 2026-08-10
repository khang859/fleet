// src/shared/shell-profiles.ts

/**
 * Identifies which filesystem semantics a path/process operates under.
 * - 'posix'        — macOS, Linux native
 * - 'win32'        — Windows native (PowerShell, cmd, Git Bash on Windows)
 * - { kind: 'wsl', distro } — inside a WSL distribution
 */
export type PathContext = 'posix' | 'win32' | { kind: 'wsl'; distro: string };

/** The WSL member of `PathContext`, for the callers that need its `distro`. */
export type WslPathContext = Extract<PathContext, object>;

/**
 * Narrow a `PathContext` to its WSL variant.
 *
 * The object member is the only non-string one, so `typeof` settles it on its own; also
 * testing `kind === 'wsl'` would only re-check what the type already guarantees. Should a
 * second object-shaped context ever join it (ssh, container), this is the single place
 * that has to start discriminating on `kind`.
 */
export function isWslContext(ctx: PathContext | undefined): ctx is WslPathContext {
  return typeof ctx === 'object';
}

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
