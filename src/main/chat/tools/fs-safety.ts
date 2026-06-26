import { homedir } from 'os';
import { resolve, sep } from 'path';

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
 * Throw if `target` resolves to a credential path or sensitive file. Returns
 * the resolved absolute path on success. `cwd` anchors relative paths.
 */
export function assertReadablePath(target: string, cwd: string): string {
  const abs = resolve(cwd, target);
  const lower = process.platform === 'win32' ? abs.toLowerCase() : abs;

  for (const root of credentialDenyRoots()) {
    const r = process.platform === 'win32' ? root.toLowerCase() : root;
    if (lower === r || lower.startsWith(r + sep)) {
      throw new Error(`Access denied: ${target} is a protected credential path`);
    }
  }
  const base = abs.split(sep).pop() ?? '';
  if (DENY_BASENAMES.some((re) => re.test(base))) {
    throw new Error(`Access denied: ${base} is a protected file`);
  }
  return abs;
}

function isUnder(child: string, parent: string): boolean {
  const c = process.platform === 'win32' ? child.toLowerCase() : child;
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent;
  return c === p || c.startsWith(p + sep);
}

/**
 * Throw if `target` is not a safe write destination. Writes must land inside one
 * of `writableRoots`, must not touch credential files, and hit hard
 * circuit-breakers (`.git/` internals, the fork-bomb of write paths) that the
 * agent can never bypass. Returns the resolved absolute path on success.
 */
export function assertWritablePath(target: string, cwd: string, writableRoots: string[]): string {
  // Credential / sensitive-file denies apply to writes too.
  const abs = assertReadablePath(target, cwd);

  // Circuit-breakers: never write into a .git directory (e.g. .git/config).
  if (abs.split(sep).includes('.git')) {
    throw new Error('Access denied: writing inside a .git directory is not allowed');
  }

  const roots = writableRoots.map((r) => resolve(r));
  if (!roots.some((r) => isUnder(abs, r))) {
    throw new Error(`Access denied: ${target} is outside the writable workspace`);
  }
  return abs;
}
