/** One step of the trail from a root down to the folder being browsed. */
export type Crumb = {
  /** What the segment is called - `~` and `/` for the two roots. */
  label: string;
  /** Absolute path the segment navigates to. */
  path: string;
};

/** Drop trailing separators, but never turn a posix root into the empty string. */
export function stripTrailing(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Parent of an absolute path, or null at a filesystem root. Tolerates both
 * separators so the same code serves posix homes and `C:\Users\...` alike.
 */
export function parentDir(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return null;
  if (idx === 0) return '/';
  const head = trimmed.slice(0, idx);
  // A bare drive letter is not a directory - `C:` has to be spelled `C:\`.
  return /^[A-Za-z]:$/.test(head) ? head + '\\' : head;
}

/** The root a path descends from, when it is not one of the user's own folders. */
function rootOf(path: string): Crumb {
  const drive = /^([A-Za-z]:)/.exec(path);
  return drive ? { label: drive[1], path: drive[1] + '\\' } : { label: '/', path: '/' };
}

/**
 * The clickable trail from a root down to `dir`, so every ancestor is one click
 * away rather than one `..` at a time. Paths inside the user's home start at
 * `~` - the home folder is the root that matters, and spelling out
 * `/Users/someone` ahead of every trail buries the part that identifies it.
 */
export function crumbTrail(dir: string, homeDir: string): Crumb[] {
  const target = stripTrailing(dir);
  const home = stripTrailing(homeDir);
  const inHome =
    target === home || (target.startsWith(home) && /^[\\/]/.test(target.slice(home.length)));

  const root = inHome ? { label: '~', path: home } : rootOf(target);
  const rest = target.slice(inHome ? home.length : root.path.length);
  // Follow whichever separator the path itself uses, so a Windows trail keeps
  // producing Windows paths.
  const sep = target.includes('\\') ? '\\' : '/';

  const crumbs = [root];
  let path = root.path;
  for (const segment of rest.split(/[\\/]/).filter(Boolean)) {
    path = /[\\/]$/.test(path) ? path + segment : path + sep + segment;
    crumbs.push({ label: segment, path });
  }
  return crumbs;
}
