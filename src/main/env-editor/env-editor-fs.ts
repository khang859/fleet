import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdtempSync
} from 'node:fs';
import { join, relative, sep, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnvFile } from '../../shared/env-parse';
import type { EnvFileEntry } from '../../shared/env-editor-types';

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
