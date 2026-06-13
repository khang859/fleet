import type { PathContext } from './shell-profiles';

const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/;

export function isWindowsPath(p: string): boolean {
  return WINDOWS_PATH_RE.test(p);
}

export function isWslPath(p: string): boolean {
  return p.startsWith('/');
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
  const rest = (m[2] ?? '').replace(/^\//, '').replace(/\//g, '\\');
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
  const rest = (m[2] ?? '').replace(/\\/g, '/');
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
