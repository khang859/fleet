// Rune is Fleet's flagship coding agent. Unlike Pi (which Fleet npm-installs into ~/.fleet),
// Rune is a user-installed binary expected on PATH. These constants are renderer-safe (no Node
// imports) so both the main process (spawn guard, version check) and the renderer (Settings
// section, Kanban banner) import the same source of truth.

/** Result of probing for the `rune` binary. */
export type RuneStatus = { installed: true; version: string } | { installed: false };

export const RUNE_REPO_URL = 'https://github.com/khang859/rune';

/** One-liner shown wherever we tell the user to install Rune. */
export const RUNE_INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/khang859/rune/main/install.sh | sh';

/**
 * The failure reason recorded on a task whose spawn was blocked because Rune is missing.
 * Specific and constructive (NN/g): names the cause and the fix instead of "pid not alive".
 */
export const RUNE_NOT_INSTALLED_MESSAGE =
  `Rune couldn't be found on your PATH, so this task can't run. Open Settings → Rune to ` +
  `install it (or fix your PATH if it's already installed), then retry.`;
