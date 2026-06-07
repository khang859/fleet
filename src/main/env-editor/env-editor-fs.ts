import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
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

const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'out',
  'coverage'
]);
const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.defaults'];

function isEnvName(name: string): boolean {
  return name.startsWith('.env');
}
function isTemplateName(name: string): boolean {
  return TEMPLATE_SUFFIXES.some((s) => name.endsWith(s));
}

function toEntry(root: string, full: string): EnvFileEntry {
  const name = basename(full);
  const rel = relative(root, full).split(sep).join('/');
  const slash = rel.lastIndexOf('/');
  const dir = slash === -1 ? '' : rel.slice(0, slash);
  let varCount = 0;
  let readable = true;
  try {
    varCount = parseEnvFile(readFileSync(full, 'utf8')).lines.filter(
      (l) => l.kind === 'var'
    ).length;
  } catch {
    readable = false;
  }
  return {
    absPath: full,
    relPath: rel,
    group: dir === '' ? '·root' : dir,
    name,
    isTemplate: isTemplateName(name),
    varCount,
    readable
  };
}

function sortEntries(entries: EnvFileEntry[]): EnvFileEntry[] {
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

export function softDeleteEnvFile(absPath: string): EnvTrashResult {
  const trashDir = mkdtempSync(join(tmpdir(), 'fleet-env-trash-'));
  const trashPath = join(trashDir, basename(absPath));
  renameSync(absPath, trashPath);
  return { trashPath };
}

export function restoreEnvFile(trashPath: string, absPath: string): { ok: true } {
  renameSync(trashPath, absPath);
  return { ok: true };
}

/** Recursively find all .env* files under root (templates included). */
export function listEnvFiles(root: string, maxDepth = 4): EnvFileEntry[] {
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
