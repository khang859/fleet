const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/;

export function isWindowsPath(p: string): boolean {
  return WINDOWS_PATH_RE.test(p);
}

export function isWslPath(p: string): boolean {
  return p.startsWith('/');
}
