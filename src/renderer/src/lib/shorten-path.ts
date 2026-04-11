const HOME = window.fleet.homeDir;

/** Shorten a CWD path for display: replaces home with ~, truncates long middle segments */
export function shortenPath(cwd: string): string {
  const withTilde = cwd.startsWith(HOME) ? '~' + cwd.slice(HOME.length) : cwd;
  if (withTilde.length <= 30) return withTilde;
  const parts = withTilde.split('/').filter(Boolean);
  if (parts.length <= 2) return withTilde;
  const prefix = withTilde.startsWith('~') ? '~' : '';
  return `${prefix}/\u2026/${parts.slice(-2).join('/')}`;
}
