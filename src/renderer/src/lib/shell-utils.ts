/**
 * Quotes a file path for safe shell insertion.
 * On POSIX: wraps in single quotes, escaping any internal single quotes.
 * On Windows: wraps in double quotes, escaping any internal double quotes.
 */
export function quotePathForShell(filePath: string, platform: string): string {
  if (platform === 'win32') {
    return '"' + filePath.replace(/"/g, '\\"') + '"';
  }
  // POSIX: single-quote, escape internal single quotes as '\''
  return "'" + filePath.replace(/'/g, "'\\''") + "'";
}

/**
 * Wraps text in bracketed paste escape sequences so the terminal treats it
 * as pasted content rather than raw keystrokes. This prevents interactive
 * programs (vim, agents, shells) from interpreting the characters as commands.
 */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}
