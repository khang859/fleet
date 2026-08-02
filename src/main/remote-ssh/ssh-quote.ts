// src/main/remote-ssh/ssh-quote.ts

/**
 * Quoting for the two remote grammars this feature speaks. **This module is the
 * security boundary for the whole remote-ssh feature** - every remote path that
 * leaves Fleet passes through one of these two functions.
 *
 * The reason both exist: `ssh host <args...>` does *not* marshal argv to the far
 * side. The local client joins the trailing arguments with spaces and hands the
 * resulting single string to the remote user's login shell, which re-parses it.
 * So anything interpolated into a remote command must be quoted *for a POSIX
 * shell* by us. SFTP, by contrast, is a separate grammar with no shell at all.
 */

/**
 * Quote a string for a POSIX shell by wrapping it in single quotes, which
 * suppress every form of expansion. The only character that cannot appear
 * inside single quotes is `'` itself, so each one is closed, escaped, reopened
 * (`'` -> `'\''`). Total, and correct for arbitrary bytes including newlines.
 */
export function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a path for an `sftp -b` batch line. sftp's own parser is line-oriented
 * and understands double quotes with backslash escapes - but it has **no way to
 * represent a newline or NUL inside a path**, so those are refused outright
 * rather than encoded into something that would silently address a different
 * file. Callers surface the thrown error as a normal operation failure.
 */
export function sftpQuote(remotePath: string): string {
  if (remotePath.includes('\n') || remotePath.includes('\r')) {
    throw new Error('Path contains a newline, which SFTP batch mode cannot express');
  }
  if (remotePath.includes('\0')) {
    throw new Error('Path contains a NUL byte');
  }
  return `"${remotePath.replace(/([\\"])/g, '\\$1')}"`;
}

/**
 * Join a remote POSIX directory and a child name. Kept here (rather than using
 * Node's `path.posix.join`) so remote path building never accidentally picks up
 * win32 separator semantics when Fleet runs on Windows.
 */
export function remoteJoin(dir: string, name: string): string {
  if (name.startsWith('/')) return name;
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`;
}

/** The parent directory of a remote POSIX path. Root is its own parent. */
export function remoteDirname(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** The final segment of a remote POSIX path. */
export function remoteBasename(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '');
  if (!trimmed) return '/';
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}
