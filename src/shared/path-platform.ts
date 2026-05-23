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

function winToWslMountPath(winPath: string): string | null {
  // C:\Users\khang → /mnt/c/Users/khang
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return null;
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
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
