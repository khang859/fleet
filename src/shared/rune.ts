// Rune is Fleet's flagship coding agent. Unlike Pi (which Fleet npm-installs into ~/.fleet),
// Rune is a user-installed binary expected on PATH. These constants are renderer-safe (no Node
// imports) so both the main process (spawn guard, version check) and the renderer (Settings
// section) import the same source of truth.

/** Result of probing for the `rune` binary. */
export type RuneStatus = { installed: true; version: string } | { installed: false };

/**
 * Result of running the install script (install or update — they're the same operation, since
 * re-running install.sh replaces the binary in place). `previousVersion` is null when Rune wasn't
 * installed beforehand; `status` is a fresh re-probe so the renderer can report install vs. update
 * and whether the version actually changed.
 */
export type RuneInstallResult = { previousVersion: string | null; status: RuneStatus };

export const RUNE_REPO_URL = 'https://github.com/khang859/rune';

/** One-liner shown wherever we tell the user to install Rune. */
export const RUNE_INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/khang859/rune/main/install.sh | sh';

/**
 * The failure reason shown when a spawn was blocked because Rune is missing.
 * Specific and constructive (NN/g): names the cause and the fix.
 */
export const RUNE_NOT_INSTALLED_MESSAGE =
  `Rune couldn't be found on your PATH, so this can't run. Open Settings → Rune to ` +
  `install it (or fix your PATH if it's already installed), then retry.`;

/**
 * A provider auth/credential failure in Rune's output.
 *
 * Rune exits non-zero on an expired or missing credential, and the exit code
 * alone reads as a generic crash. Matching the text lets a caller say "sign in
 * again" instead of surfacing a cryptic failure. Provider-agnostic by design.
 */
const AUTH_FAILURE_RE =
  /auth(?:entication)?\s+(?:refresh\s+)?failed|refresh_token|sign(?:ing)?\s+in\s+again|invalid_grant|invalid[_\s]?api[_\s]?key|missing\s+api\s+key|\bunauthorized\b|\b401\b/i;

/** True when Rune output shows a provider auth/credential failure. */
export function isAuthFailureText(text: string): boolean {
  return AUTH_FAILURE_RE.test(text);
}
