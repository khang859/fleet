import { realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';

/**
 * Credential / secret paths that read tools must never expose, regardless of
 * the permission rules. These are checked in the main process against the
 * fully-resolved absolute path.
 */
function credentialDenyRoots(): string[] {
  const home = homedir();
  return [
    resolve(home, '.ssh'),
    resolve(home, '.aws'),
    resolve(home, '.gnupg'),
    resolve(home, '.config', 'gh'),
    resolve(home, '.npmrc'),
    resolve(home, '.netrc')
  ];
}

/** Filename patterns that are sensitive anywhere in the tree. */
const DENY_BASENAMES = [/^\.env(\..+)?$/, /^\.npmrc$/, /^id_(rsa|ed25519|ecdsa)$/, /\.pem$/];

/**
 * Resolve `abs` through any symlinks so confinement can't be bypassed by a link
 * pointing outside the workspace. The target file may not exist yet (a fresh
 * `write_file`), so realpath the longest existing ancestor and re-append the
 * not-yet-created tail. Returns a lexical fallback if nothing resolves.
 */
function realpathOrNearest(abs: string): string {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // reached the filesystem root; nothing exists
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

function norm(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isUnder(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + sep);
}

/**
 * Throw if `target` resolves to a credential path, a sensitive file, or outside
 * the readable workspace. `cwd` anchors relative paths; reads are confined to
 * `readableRoots` (defaults to the workspace cwd). Symlinks are resolved before
 * every check so a link can't point out of the sandbox. Returns the resolved
 * absolute path on success.
 */
export function assertReadablePath(
  target: string,
  cwd: string,
  readableRoots: string[] = [cwd]
): string {
  const abs = resolve(cwd, target);
  const real = realpathOrNearest(abs);
  const lower = norm(real);

  // Credential / sensitive-file denies take precedence (clearest error message).
  for (const root of credentialDenyRoots()) {
    const r = norm(root);
    if (lower === r || lower.startsWith(r + sep)) {
      throw new Error(`Access denied: ${target} is a protected credential path`);
    }
  }
  const base = real.split(sep).pop() ?? '';
  if (DENY_BASENAMES.some((re) => re.test(base))) {
    throw new Error(`Access denied: ${base} is a protected file`);
  }

  // Workspace confinement: the resolved real path must live inside a root.
  const roots = readableRoots.map((r) => realpathOrNearest(resolve(r)));
  if (!roots.some((r) => isUnder(real, r))) {
    throw new Error(`Access denied: ${target} is outside the readable workspace`);
  }
  return abs;
}

/**
 * Throw if `target` is not a safe write destination. Writes must land inside one
 * of `writableRoots`, must not touch credential files, and hit hard
 * circuit-breakers (`.git/` internals) that the agent can never bypass.
 * Symlinks are resolved before the checks. Returns the resolved absolute path.
 */
export function assertWritablePath(target: string, cwd: string, writableRoots: string[]): string {
  // Credential / sensitive-file denies + workspace confinement apply to writes
  // too — assertReadablePath confines the realpath to `writableRoots` already.
  const abs = assertReadablePath(target, cwd, writableRoots);

  // Circuit-breaker: never write into a .git directory (e.g. .git/config).
  if (realpathOrNearest(abs).split(sep).includes('.git')) {
    throw new Error('Access denied: writing inside a .git directory is not allowed');
  }
  return abs;
}
