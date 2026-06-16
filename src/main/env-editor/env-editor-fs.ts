import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  unlinkSync
} from 'node:fs';
import { join, relative, sep, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnvFile } from '../../shared/env-parse';
import type {
  EnvFileEntry,
  EnvReadResult,
  EnvWriteResult,
  EnvPathResult,
  EnvTrashResult
} from '../../shared/env-editor-types';

/** Directory names skipped when discovering .env files. Shared with the WSL
 *  in-distro `find` path (env-editor-wsl.ts) so both walkers prune identically. */
export const ENV_EXCLUDE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'out',
  'coverage'
];
/** Max directory depth (root = 0) descended when discovering .env files. */
export const ENV_MAX_DEPTH = 4;

const EXCLUDE_DIRS = new Set(ENV_EXCLUDE_DIRS);
const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.defaults'];

function isEnvName(name: string): boolean {
  return name.startsWith('.env');
}
function isTemplateName(name: string): boolean {
  return TEMPLATE_SUFFIXES.some((s) => name.endsWith(s));
}

/**
 * Build an entry from a forward-slash relative path, an OS-accessible absolute
 * path, and the file's text (or null if it could not be read). Shared by the
 * native walker and the WSL in-distro path so entry shaping stays identical.
 */
export function buildEnvEntry(relPath: string, absPath: string, text: string | null): EnvFileEntry {
  const slash = relPath.lastIndexOf('/');
  const name = slash === -1 ? relPath : relPath.slice(slash + 1);
  const dir = slash === -1 ? '' : relPath.slice(0, slash);
  let varCount = 0;
  let readable = text !== null;
  if (text !== null) {
    try {
      varCount = parseEnvFile(text).lines.filter((l) => l.kind === 'var').length;
    } catch {
      readable = false;
    }
  }
  return {
    absPath,
    relPath,
    group: dir === '' ? '·root' : dir,
    name,
    isTemplate: isTemplateName(name),
    varCount,
    readable
  };
}

function toEntry(root: string, full: string): EnvFileEntry {
  const rel = relative(root, full).split(sep).join('/');
  let text: string | null;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    text = null;
  }
  return buildEnvEntry(rel, full, text);
}

export function sortEntries(entries: EnvFileEntry[]): EnvFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.group !== b.group) {
      if (a.group === '·root') return -1;
      if (b.group === '·root') return 1;
      return a.group.localeCompare(b.group);
    }
    return a.name.localeCompare(b.name);
  });
}

let tmpCounter = 0;

export function readEnvFile(absPath: string): EnvReadResult {
  const mtimeMs = statSync(absPath).mtimeMs;
  return { text: readFileSync(absPath, 'utf8'), mtimeMs };
}

/** Atomic write (temp + rename). If expectedMtimeMs is given and the file is newer, refuse. */
export function writeEnvFile(
  absPath: string,
  text: string,
  expectedMtimeMs?: number
): EnvWriteResult {
  // If the file was deleted externally, skip the conflict check and write fresh.
  if (expectedMtimeMs !== undefined && existsSync(absPath)) {
    const current = statSync(absPath).mtimeMs;
    if (current > expectedMtimeMs) {
      return { ok: false, externalChange: true, mtimeMs: current };
    }
  }
  const tmp = `${absPath}.fleet-tmp-${process.pid}-${Date.now()}-${tmpCounter++}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, absPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
  return { ok: true, mtimeMs: statSync(absPath).mtimeMs };
}

function assertEnvName(name: string): void {
  if (!name.startsWith('.env')) throw new Error('File name must start with ".env"');
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('File name must not contain path separators');
  }
}

export function createEnvFile(dir: string, name: string): EnvPathResult {
  assertEnvName(name);
  const full = join(dir, name);
  if (existsSync(full)) throw new Error('A file with that name already exists');
  writeFileSync(full, '', 'utf8');
  return { absPath: full };
}

export function renameEnvFile(absPath: string, newName: string): EnvPathResult {
  assertEnvName(newName);
  const next = join(dirname(absPath), newName);
  if (existsSync(next)) throw new Error('A file with that name already exists');
  renameSync(absPath, next);
  return { absPath: next };
}

function moveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EXDEV') {
      copyFileSync(src, dest);
      unlinkSync(src);
    } else {
      throw err;
    }
  }
}

export function softDeleteEnvFile(absPath: string): EnvTrashResult {
  const trashDir = mkdtempSync(join(tmpdir(), 'fleet-env-trash-'));
  const trashPath = join(trashDir, basename(absPath));
  moveFile(absPath, trashPath);
  return { trashPath };
}

export function restoreEnvFile(trashPath: string, absPath: string): { ok: true } {
  moveFile(trashPath, absPath);
  return { ok: true };
}

/** Recursively find all .env* files under root (templates included). */
export function listEnvFiles(root: string, maxDepth = ENV_MAX_DEPTH): EnvFileEntry[] {
  const out: EnvFileEntry[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!EXCLUDE_DIRS.has(name)) walk(full, depth + 1);
      } else if (isEnvName(name)) {
        out.push(toEntry(root, full));
      }
    }
  };
  walk(root, 0);
  return sortEntries(out);
}
