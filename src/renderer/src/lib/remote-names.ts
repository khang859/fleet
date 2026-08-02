/**
 * Remote path and name rules shared by the SSH browser's store and dialogs.
 *
 * Kept out of both so the rules can be tested directly, and so the dialog is not
 * the only place that knows what a legal name is.
 */

/** Join a remote POSIX directory and a child name. */
export function remoteChildPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`;
}

/**
 * Reject names the remote could not represent, or that would silently address a
 * different directory. Returns the message to show, or null when the name is fine.
 *
 * `/` is refused rather than escaped: a rename field is for naming one thing, and
 * quietly accepting a path there would move the file somewhere the user cannot see.
 */
export function validateRemoteName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name.';
  if (trimmed === '.' || trimmed === '..') return 'That name is reserved.';
  if (trimmed.includes('/')) return 'A name cannot contain "/".';
  // SFTP batch mode has no way to express either byte inside a path.
  if (/[\n\r]/.test(trimmed)) return 'A name cannot contain line breaks.';
  if (trimmed.includes('\0')) return 'A name cannot contain a null byte.';
  return null;
}
