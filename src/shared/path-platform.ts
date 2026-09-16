import { isWslContext, type PathContext } from './shell-profiles';

const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/;

export function isWindowsPath(p: string): boolean {
  return WINDOWS_PATH_RE.test(p);
}

export function isWslPath(p: string): boolean {
  return p.startsWith('/');
}

/**
 * A Windows network path, in either spelling.
 *
 * Worth a name of its own because one caller uses the answer to gate a security
 * decision rather than a formatting one: handed to the shell on Windows,
 * `\\host\share` makes the OS authenticate to that host, so any path that
 * reaches a reveal or an open has to be checked. The `fleet-image` and
 * `fleet-pdf` handlers ask the same question for a milder reason - Node `fs`
 * reads the WSL 9P share natively where `net.fetch` does not. One copy, so the
 * two uses cannot drift apart.
 */
export function isUncPath(p: string): boolean {
  return p.startsWith('\\\\') || p.startsWith('//');
}

function separators(ctx: PathContext): RegExp {
  return ctx === 'win32' ? /[\\/]+/ : /\/+/;
}

export function basename(p: string, ctx: PathContext): string {
  if (!p) return 'Shell';
  const sep = separators(ctx);
  const trimmed = p.replace(/[\\/]+$/, '');
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return 'Shell';
  const parts = trimmed.split(sep);
  return parts[parts.length - 1] || 'Shell';
}

export function join(ctx: PathContext, ...segments: string[]): string {
  const sep = ctx === 'win32' ? '\\' : '/';
  const cleaned = segments
    .filter((s) => s.length > 0)
    .map((s, i) => {
      // Strip leading separators on all but the first segment
      // Strip trailing separators on all but the last
      let out = s;
      if (i > 0) out = out.replace(/^[\\/]+/, '');
      if (i < segments.length - 1) out = out.replace(/[\\/]+$/, '');
      return out;
    })
    .filter((s) => s.length > 0);
  return cleaned.join(sep);
}

type DisplayPathHomes = {
  homeDir: string;
  /** Map of distro name → POSIX home inside the distro (e.g. '/home/khang'). */
  wslHomeByDistro: Record<string, string>;
};

export function winToWslMountPath(winPath: string): string | null {
  // C:\Users\khang → /mnt/c/Users/khang
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return null;
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

/**
 * Inverse of {@link winToWslMountPath}: a WSL automount path back to a Windows
 * drive path. Matches a **single drive letter only** — `/mnt/wsl`, `/mnt/wslg`
 * and other multi-char automount entries return null (they have no drive form).
 *   '/mnt/c/Users/khang' → 'C:\\Users\\khang'   '/mnt/d' → 'D:\\'
 */
export function wslMountToWinPath(posixPath: string): string | null {
  const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(posixPath);
  if (!m) return null;
  const drive = m[1].toUpperCase();
  const rest = (m.at(2) ?? '').replace(/^\//, '').replace(/\//g, '\\');
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

/**
 * Build a modern WSL UNC path that Windows `fs` can read natively.
 *   ('Ubuntu-24.04', '/home/khang/pic.png') → '\\\\wsl.localhost\\Ubuntu-24.04\\home\\khang\\pic.png'
 */
export function toWslUncPath(distro: string, posixPath: string): string {
  const segs = posixPath.split('/').filter((s) => s.length > 0);
  return `\\\\wsl.localhost\\${distro}\\${segs.join('\\')}`;
}

/**
 * Parse a WSL UNC path (modern `\\wsl.localhost\` or legacy `\\wsl$\`, forward
 * or back slashes) into its distro + POSIX path. Returns null if not a WSL UNC.
 */
export function parseWslUncPath(p: string): { distro: string; posixPath: string } | null {
  const normalized = p.replace(/\//g, '\\');
  const m = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/.exec(normalized);
  if (!m) return null;
  const distro = m[1];
  const rest = (m.at(2) ?? '').replace(/\\/g, '/');
  const posixPath = rest === '' ? '/' : rest.replace(/\/+$/, '') || '/';
  return { distro, posixPath };
}

/**
 * Strategy 1 — make a path readable by the win32 main process given the pane's
 * coordinate system. win32/posix pass through unchanged. For a WSL pane:
 *   already a drive path or UNC → passthrough
 *   `/mnt/<single-drive>/…`      → drive path (skips the 9P share, faster)
 *   any other `/…`               → `\\wsl.localhost\<distro>\…` UNC bridge
 */
export function toWindowsAccessiblePath(p: string, ctx: PathContext): string {
  if (ctx === 'win32' || ctx === 'posix') return p;
  if (isWindowsPath(p)) return p;
  if (parseWslUncPath(p)) return p;
  const drive = wslMountToWinPath(p);
  if (drive) return drive;
  if (p.startsWith('/')) return toWslUncPath(ctx.distro, p);
  return p;
}

/**
 * Strategy 3 — convert a path into the coordinate system of the pane it is being
 * pasted into. For a WSL pane we want POSIX: a Windows drive path becomes
 * `/mnt/<drive>/…`, a same-distro UNC path becomes its POSIX form. win32/posix
 * panes and already-correct paths pass through.
 */
export function pathForPaneContext(p: string, ctx: PathContext): string {
  if (ctx === 'win32' || ctx === 'posix') return p;
  if (isWindowsPath(p)) {
    return winToWslMountPath(p) ?? p;
  }
  const unc = parseWslUncPath(p);
  if (unc?.distro === ctx.distro) return unc.posixPath;
  return p;
}

/**
 * Canonical builder for the `fleet-image://` / `fleet-pdf://` schemes. Puts the
 * absolute path in the URL **path** position with an empty authority and
 * per-segment percent-encoding, so it round-trips drive paths, UNC paths and
 * POSIX paths (incl. spaces, Unicode, `#`, `?`) without `new URL` mangling.
 *   'C:\\a b.png'                    → 'fleet-image:///C%3A/a%20b.png'
 *   '\\\\wsl.localhost\\U\\a.png'    → 'fleet-image:////wsl.localhost/U/a.png'
 *   '/home/k/a.png'                  → 'fleet-image:///home/k/a.png'
 */
function buildFleetUrl(scheme: string, absPath: string): string {
  let s = absPath.replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  const encoded = s.split('/').map(encodeURIComponent).join('/');
  return `${scheme}://${encoded}`;
}

export function toFleetImageUrl(absPath: string): string {
  return buildFleetUrl('fleet-image', absPath);
}

export function toFleetPdfUrl(absPath: string): string {
  return buildFleetUrl('fleet-pdf', absPath);
}

/**
 * The inverse of {@link displayPath}: a leading `~` becomes the home directory
 * the pane's context actually has. Anything else passes through, so this is safe
 * to call on every candidate without checking first.
 *
 * A WSL pane prefers its distro's own home and falls back to the Windows home
 * seen through `/mnt`, matching the order `displayPath` collapses them in. With
 * no home to substitute the `~` is left alone, which then fails to resolve -
 * better than inventing a path.
 */
export function expandHome(p: string, ctx: PathContext, homes: DisplayPathHomes): string {
  if (p !== '~' && !/^~[\\/]/.test(p)) return p;
  const rest = p.slice(1).replace(/^[\\/]/, '');

  if (isWslContext(ctx)) {
    // The map only holds distros whose home has been read, so a miss is an
    // empty lookup rather than an error; the Windows home mounted into the
    // distro is the fallback.
    const distroHome = homes.wslHomeByDistro[ctx.distro];
    const home = distroHome || winToWslMountPath(homes.homeDir);
    if (!home) return p;
    return rest ? join(ctx, home, rest) : home;
  }

  if (!homes.homeDir) return p;
  return rest ? join(ctx, homes.homeDir, rest) : homes.homeDir;
}

/**
 * Turn a path printed in a terminal into an absolute one, using the folder that
 * pane is standing in.
 *
 * Already-absolute paths pass through untouched, so `cwd` is only consulted for
 * the relative ones. `.` and `..` segments are collapsed here rather than left
 * for the OS, because the result is compared against a cache key and shown to
 * the user, and `/a/b/../c` and `/a/c` should not be two different things.
 *
 * Returns null when there is nothing to resolve against - a relative path in a
 * pane whose cwd has not been reported yet. The caller treats that as "no
 * candidate" rather than guessing at a root.
 */
export function resolveAgainstCwd(p: string, cwd: string, ctx: PathContext): string | null {
  if (!p) return null;

  const absolute = ctx === 'win32' ? isWindowsPath(p) : isWslPath(p);
  if (!absolute && !cwd) return null;

  const combined = absolute ? p : join(ctx, cwd, p);
  return normalizeSegments(combined, ctx);
}

/**
 * Collapse `.` and `..` without letting `..` escape the root or the drive.
 *
 * The prefix is preserved verbatim (`/`, `C:\`, `//`) and only the segments
 * after it are walked, which is what keeps a drive letter from being eaten by a
 * leading `..`. A trailing separator is dropped, since nothing downstream cares
 * and it would otherwise split one real directory into two cache keys.
 */
function normalizeSegments(p: string, ctx: PathContext): string {
  const sep = ctx === 'win32' ? '\\' : '/';
  const driveMatch = /^([A-Za-z]:)[\\/]/.exec(p);
  const prefix = driveMatch ? `${driveMatch[1]}${sep}` : /^[\\/]/.test(p) ? sep : '';
  const body = p.slice(driveMatch ? driveMatch[0].length : prefix.length);

  const out: string[] = [];
  for (const segment of body.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Relative with no prefix keeps a leading `..` - there is no root to stop
      // at, and dropping it would silently change which directory is meant.
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!prefix) out.push('..');
      continue;
    }
    out.push(segment);
  }

  const joined = out.join(sep);
  return prefix ? prefix + joined : joined;
}

export function displayPath(p: string, ctx: PathContext, homes: DisplayPathHomes): string {
  if (!p) return '';

  if (ctx === 'win32') {
    if (homes.homeDir && p === homes.homeDir) return '~';
    if (homes.homeDir && p.startsWith(homes.homeDir + '\\')) {
      return '~' + p.slice(homes.homeDir.length);
    }
    return p;
  }

  if (ctx === 'posix') {
    if (homes.homeDir && p === homes.homeDir) return '~';
    if (homes.homeDir && p.startsWith(homes.homeDir + '/')) {
      return '~' + p.slice(homes.homeDir.length);
    }
    return p;
  }

  // WSL
  const wslHome = homes.wslHomeByDistro[ctx.distro];
  if (wslHome) {
    if (p === wslHome) return '~';
    if (p.startsWith(wslHome + '/')) return '~' + p.slice(wslHome.length);
  }
  // /mnt/c/Users/khang → ~/  (when win-home matches)
  const mounted = homes.homeDir ? winToWslMountPath(homes.homeDir) : null;
  if (mounted) {
    if (p === mounted) return '~';
    if (p.startsWith(mounted + '/')) return '~' + p.slice(mounted.length);
  }
  return p;
}
