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
