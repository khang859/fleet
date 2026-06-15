import type { PathContext } from '../../../shared/shell-profiles';

/**
 * Quotes a file path for safe shell insertion, keyed on the pane's coordinate
 * system (NOT the host platform — a WSL pane on Windows runs a POSIX shell).
 * win32: wraps in double quotes; posix/wsl: single quotes, escaping internals.
 */
export function quotePathForShell(filePath: string, pathContext: PathContext): string {
  if (pathContext === 'win32') {
    return '"' + filePath.replace(/"/g, '\\"') + '"';
  }
  // POSIX/WSL: single-quote, escape internal single quotes as '\''
  return "'" + filePath.replace(/'/g, "'\\''") + "'";
}

/**
 * Wraps text in bracketed paste escape sequences so the terminal treats it
 * as pasted content rather than raw keystrokes. This prevents interactive
 * programs (vim, agents, shells) from interpreting the characters as commands.
 */
/**
 * Joins path segments using the OS-appropriate separator.
 */
export function joinPath(...segments: string[]): string {
  const sep = window.fleet.platform === 'win32' ? '\\' : '/';
  return segments.join(sep);
}

export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}
