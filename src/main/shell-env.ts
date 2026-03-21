import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Shell environment resolution ────────────────────────────────────────────
//
// Packaged Electron apps on macOS/Linux inherit a minimal PATH from launchd
// (/usr/bin:/bin:/usr/sbin:/sbin). Tools installed via Homebrew, nvm, fnm,
// volta, etc. are invisible. This module resolves the user's real shell
// environment once at startup and merges it into process.env.

let resolved = false;

/**
 * Enrich `process.env` with the user's login shell environment.
 * Uses `shell-env` (same strategy as VS Code) with a fallback to probing
 * known install locations. Safe to call multiple times — only runs once.
 */
export async function enrichProcessEnv(): Promise<void> {
  if (resolved) return;
  resolved = true;

  // Windows inherits PATH correctly from the desktop — nothing to do
  if (process.platform === 'win32') return;

  try {
    const env = await withTimeout(resolveShellEnv(), 5000);
    // Merge shell env into process.env. Shell env wins for PATH (the whole
    // point), but we preserve any Electron-specific vars already set.
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
    console.log(`[shell-env] Resolved PATH (${process.env.PATH?.substring(0, 120)}…)`);
  } catch (err) {
    console.warn('[shell-env] Failed to resolve shell env, falling back to path probing:', err);
    applyFallbackPaths();
  }
}

async function resolveShellEnv(): Promise<Record<string, string>> {
  const { shellEnv } = await import('shell-env');
  return shellEnv();
}

/**
 * Fallback: probe well-known install locations and prepend them to PATH.
 * Mirrors the nodeResolverScript logic from install-fleet-cli.ts.
 */
function applyFallbackPaths(): void {
  const home = homedir();
  const candidates = [
    join(home, '.volta', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin'
  ];

  // nvm: try default alias, then latest installed version
  const nvmDir = join(home, '.nvm', 'versions', 'node');
  const nvmAlias = join(home, '.nvm', 'alias', 'default');
  if (existsSync(nvmAlias)) {
    try {
      let version = readFileSync(nvmAlias, 'utf8').trim();
      // nvm default can be an indirect alias (e.g. "lts/*", "lts/iron") — resolve one level
      const indirectAlias = join(home, '.nvm', 'alias', version);
      if (existsSync(indirectAlias)) {
        try {
          version = readFileSync(indirectAlias, 'utf8').trim();
        } catch {
          /* ignore */
        }
      }
      candidates.unshift(join(nvmDir, version, 'bin'));
    } catch {
      /* ignore */
    }
  } else if (existsSync(nvmDir)) {
    try {
      const versions = readdirSync(nvmDir).sort();
      if (versions.length > 0) {
        candidates.unshift(join(nvmDir, versions[versions.length - 1], 'bin'));
      }
    } catch {
      /* ignore */
    }
  }

  // fnm
  const fnmDir = process.env.FNM_DIR || join(home, '.local', 'share', 'fnm');
  const fnmBin = join(fnmDir, 'aliases', 'default', 'bin');
  if (existsSync(fnmBin)) {
    candidates.unshift(fnmBin);
  }

  const existing = candidates.filter((p) => existsSync(p));
  if (existing.length > 0) {
    process.env.PATH = existing.join(':') + ':' + (process.env.PATH ?? '');
    console.log(`[shell-env] Fallback PATH: ${process.env.PATH.substring(0, 120)}…`);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (val) => {
        if (!settled) {
          clearTimeout(timer);
          resolve(val);
        }
      },
      (err) => {
        if (!settled) {
          clearTimeout(timer);
          reject(err);
        }
      }
    );
  });
}
