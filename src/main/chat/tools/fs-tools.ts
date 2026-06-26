import { readFileSync, readdirSync, statSync, type Stats } from 'fs';
import { join, relative, resolve, sep } from 'path';
import { assertReadablePath } from './fs-safety';

/** Directories never descended into during glob/search. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.cache',
  'coverage'
]);

const MAX_WALK_FILES = 20_000;
const MAX_GLOB_RESULTS = 200;
const MAX_SEARCH_MATCHES = 100;
const MAX_READ_LINES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Convert a glob (`*`, `**`, `?`) to a RegExp anchored on a posix path. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches across directory separators
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++; // consume the slash after **
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Depth-first file walk, skipping ignored dirs; yields absolute file paths. */
function* walkFiles(root: string): Generator<string> {
  let count = 0;
  const stack = [root];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable dir — skip
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st: Stats;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name) && !name.startsWith('.')) stack.push(full);
      } else if (st.isFile()) {
        yield full;
        if (++count >= MAX_WALK_FILES) return;
      }
    }
  }
}

function toPosix(p: string): string {
  return sep === '\\' ? p.split(sep).join('/') : p;
}

/** read_file: read a slice of a text file. Never prompts; enforces deny paths. */
export function readFileTool(args: {
  path: string;
  cwd: string;
  offset?: number;
  limit?: number;
}): string {
  const abs = assertReadablePath(args.path, args.cwd);
  const st = statSync(abs);
  if (st.size > MAX_FILE_BYTES) throw new Error(`File too large (${st.size} bytes)`);
  const buf = readFileSync(abs);
  if (buf.includes(0)) throw new Error('Cannot read a binary file');
  const lines = buf.toString('utf8').split('\n');
  const offset = Math.max(0, args.offset ?? 0);
  const limit = Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES);
  const slice = lines.slice(offset, offset + limit);
  return slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
}

/** glob: list files whose relative posix path matches the pattern. */
export function globTool(args: { pattern: string; path?: string; cwd: string }): string[] {
  const root = assertReadablePath(args.path ?? '.', args.cwd);
  const re = globToRegExp(args.pattern);
  const matches: string[] = [];
  for (const file of walkFiles(root)) {
    const rel = toPosix(relative(root, file));
    if (re.test(rel) || re.test(toPosix(relative(root, file).split(sep).pop() ?? ''))) {
      matches.push(rel);
      if (matches.length >= MAX_GLOB_RESULTS) break;
    }
  }
  return matches;
}

/** search: regex content search across files, optionally filtered by glob. */
export function searchTool(args: {
  regex: string;
  path?: string;
  glob?: string;
  cwd: string;
}): Array<{ file: string; line: number; text: string }> {
  const root = assertReadablePath(args.path ?? '.', args.cwd);
  const re = new RegExp(args.regex);
  const globRe = args.glob ? globToRegExp(args.glob) : null;
  const out: Array<{ file: string; line: number; text: string }> = [];
  for (const file of walkFiles(root)) {
    const rel = toPosix(relative(root, file));
    if (globRe && !globRe.test(rel)) continue;
    let buf: Buffer;
    try {
      const st = statSync(file);
      if (st.size > MAX_FILE_BYTES) continue;
      buf = readFileSync(file);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push({ file: rel, line: i + 1, text: lines[i].slice(0, 300) });
        if (out.length >= MAX_SEARCH_MATCHES) return out;
      }
    }
  }
  return out;
}

export function defaultWorkspace(configured: string | null): string {
  return configured ? resolve(configured) : process.cwd();
}
