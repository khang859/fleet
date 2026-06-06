import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { EnvDiff, EnvDiffEntry } from '../../shared/env-sync-types';

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
const EXCLUDE_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.defaults'];

export type ParsedEnv = { map: Record<string, string> };

export function parseEnv(text: string): ParsedEnv {
  const map: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7) : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) map[key] = value;
  }
  return { map };
}

export function maskValue(value: string): string {
  if (value.length <= 2) return '•'.repeat(value.length);
  return '•'.repeat(value.length - 2) + value.slice(-2);
}

export function diffEnv(localText: string, remoteText: string): EnvDiff {
  const local = parseEnv(localText).map;
  const remote = parseEnv(remoteText).map;
  const keys = Array.from(new Set([...Object.keys(local), ...Object.keys(remote)])).sort();
  const entries: EnvDiffEntry[] = keys.map((key) => {
    const inLocal = key in local;
    const inRemote = key in remote;
    let change: EnvDiffEntry['change'];
    if (inLocal && !inRemote) change = 'removed';
    else if (!inLocal && inRemote) change = 'added';
    else if (local[key] !== remote[key]) change = 'changed';
    else change = 'unchanged';
    return {
      key,
      change,
      localMask: inLocal ? maskValue(local[key]) : undefined,
      remoteMask: inRemote ? maskValue(remote[key]) : undefined
    };
  });
  return { entries };
}

export function hashPlaintext(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isCandidateName(name: string): boolean {
  if (!name.startsWith('.env')) return false;
  return !EXCLUDE_SUFFIXES.some((s) => name.endsWith(s));
}

/** Returns candidate env-file paths relative to repoDir (posix-style separators). */
export function scanCandidates(repoDir: string, maxDepth = 4): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!EXCLUDE_DIRS.has(name) && !name.startsWith('.git')) walk(full, depth + 1);
      } else if (isCandidateName(name)) {
        out.push(relative(repoDir, full).split(sep).join('/'));
      }
    }
  };
  walk(repoDir, 0);
  return out;
}
