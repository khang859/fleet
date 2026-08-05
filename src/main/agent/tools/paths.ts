import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Where the agent's tools are allowed to look.
 *
 * The pane's folder is the sandbox: it is the one thing the user chose when
 * they opened the pane, and a tool that can read outside it can read anything
 * the app can. Confinement is checked against the *real* path, so a symlink
 * inside the folder cannot be used to step out of it.
 *
 * Secrets are denied even inside the folder. Reading a file here does not just
 * show it to the user - it uploads it to a model provider, which is not
 * something a `.env` in the repo can be assumed to have consented to.
 */

/** Credential stores that are never readable, wherever the pane was opened. */
function credentialRoots(): string[] {
  const home = homedir();
  return [
    resolve(home, '.ssh'),
    resolve(home, '.aws'),
    resolve(home, '.gnupg'),
    resolve(home, '.config', 'gh')
  ];
}

/** Filenames that hold secrets wherever they turn up, including inside a repo. */
const DENIED_NAMES = [
  /^\.env(\..+)?$/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/
];

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(a) === norm(b);
}

function isUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * `path` with every symlink resolved. A path that does not exist resolves as far
 * as it can and keeps the rest, so a missing file is still checked against the
 * real location of the folder it would live in.
 */
export function realpathOrNearest(path: string): string {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (samePath(parent, current)) return path;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a path a tool was asked for, or throw with a reason the model can act
 * on. Relative paths are taken against `cwd`; the returned path is absolute and
 * symlink-resolved, so it is what should actually be opened.
 */
export function resolveInsideCwd(target: string, cwd: string): string {
  const root = realpathOrNearest(resolve(cwd));
  const real = realpathOrNearest(resolve(cwd, target));

  if (!isUnder(real, root)) {
    throw new Error(`${target} is outside the working folder`);
  }
  if (credentialRoots().some((deny) => isUnder(real, realpathOrNearest(deny)))) {
    throw new Error(`${target} is a credential path`);
  }
  if (DENIED_NAMES.some((deny) => deny.test(basename(real)))) {
    throw new Error(`${basename(real)} may hold secrets and is not readable`);
  }
  return real;
}

/** True for a path a walk should not descend into or return. */
export function isDeniedName(name: string): boolean {
  return DENIED_NAMES.some((deny) => deny.test(name));
}

/**
 * How a path is written in a tool result: relative to the working folder, with
 * forward slashes, because that is how it appears in the code being read.
 */
export function displayPath(abs: string, cwd: string): string {
  const root = realpathOrNearest(resolve(cwd));
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..')) return abs;
  return rel.split(sep).join('/');
}
