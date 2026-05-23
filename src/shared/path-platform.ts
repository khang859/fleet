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
