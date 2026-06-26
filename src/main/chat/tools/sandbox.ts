import { execFileSync } from 'child_process';
import { tmpdir } from 'os';

export type SandboxConfig = {
  /** Directories the command may write to. Everything else is read-only. */
  writableRoots: string[];
  /** Deny all network access. */
  denyNetwork: boolean;
};

let cachedAvailable: boolean | null = null;

/**
 * Whether a defense-in-depth sandbox is available on this platform. Linux uses
 * bubblewrap (`bwrap`); other platforms have no supported backend yet, so this
 * returns false and callers in "auto" mode must fail closed.
 */
export function isSandboxAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable;
  if (process.platform !== 'linux') {
    cachedAvailable = false;
    return false;
  }
  try {
    execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
    cachedAvailable = true;
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

/** Reset the cached capability probe (tests). */
export function resetSandboxCache(): void {
  cachedAvailable = null;
}

/**
 * Wrap an argv with bubblewrap so the command runs with the whole filesystem
 * read-only except the writable roots, optionally with networking disabled.
 * A write outside the writable roots fails because `/` is bound read-only.
 *
 * This is the deterministic confinement; pair it with isSandboxAvailable() and
 * a fail-closed policy. Exported for unit testing the argv it produces.
 */
export function buildBwrapArgv(argv: string[], cfg: SandboxConfig): string[] {
  const out = [
    'bwrap',
    '--die-with-parent',
    '--unshare-pid',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    // A private writable /tmp.
    '--tmpfs',
    tmpdir()
  ];
  for (const root of cfg.writableRoots) {
    out.push('--bind', root, root);
  }
  if (cfg.denyNetwork) out.push('--unshare-net');
  out.push('--', ...argv);
  return out;
}

/**
 * Build a wrap() function for runBash, or null when no sandbox is available.
 */
export function makeSandboxWrap(cfg: SandboxConfig): ((argv: string[]) => string[]) | null {
  if (!isSandboxAvailable()) return null;
  return (argv) => buildBwrapArgv(argv, cfg);
}
