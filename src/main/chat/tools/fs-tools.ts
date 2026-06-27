import { readFileSync, readdirSync, lstatSync, statSync, type Stats } from 'fs';
import { readdir, readFile, lstat } from 'fs/promises';
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

/**
 * Async twin of the file-and-directory walk for the `@`-mention picker. Awaiting
 * `readdir`/`stat` hands control back to the event loop between filesystem ops,
 * so a large workspace scan never blocks the Electron main process (and the PTYs
 * that stream through it) on a mention keystroke. Mirrors {@link walkFilesAsync}
 * but also yields directories.
 */
async function* walkEntriesAsync(root: string): AsyncGenerator<{ full: string; dir: boolean }> {
  let count = 0;
  const stack = [root];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st: Stats;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // never traverse out of the workspace via a link
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name) && !name.startsWith('.')) {
          yield { full, dir: true };
          stack.push(full);
        }
      } else if (st.isFile() && !name.startsWith('.')) {
        yield { full, dir: false };
      }
      if (++count >= MAX_WALK_FILES) return;
    }
  }
}

/**
 * Fuzzy-ish path search for the `@`-mention picker: substring match on the
 * workspace-relative posix path, skipping ignored dirs/dotfiles. Basename and
 * shorter-path matches rank first. Async so the keystroke-driven walk yields to
 * the event loop instead of freezing the main process on a large workspace.
 */
export async function searchWorkspacePaths(args: {
  query: string;
  cwd: string;
  limit?: number;
}): Promise<Array<{ path: string; type: 'file' | 'dir' }>> {
  const root = resolve(args.cwd);
  const q = args.query.toLowerCase();
  const limit = args.limit ?? 20;
  const hits: Array<{ path: string; type: 'file' | 'dir'; score: number }> = [];
  for await (const { full, dir } of walkEntriesAsync(root)) {
    const rel = toPosix(relative(root, full));
    if (!rel) continue;
    const lower = rel.toLowerCase();
    if (q && !lower.includes(q)) continue;
    const base = rel.split('/').pop() ?? rel;
    const score = (base.toLowerCase().includes(q) ? 0 : 100) + rel.length;
    hits.push({ path: rel, type: dir ? 'dir' : 'file', score });
  }
  hits.sort((a, b) => a.score - b.score);
  return hits.slice(0, limit).map(({ path, type }) => ({ path, type }));
}

/**
 * Build a context block from `@`-mentioned paths: truncated contents for files,
 * a bounded file listing for directories. Each file is capped at `maxBytes`.
 */
export function buildMentionContext(args: {
  paths: string[];
  cwd: string;
  maxBytes: number;
}): string {
  const blocks: string[] = [];
  for (const p of args.paths) {
    let abs: string;
    try {
      abs = assertReadablePath(p, args.cwd);
    } catch (err) {
      blocks.push(`${p}: (skipped — ${err instanceof Error ? err.message : 'unreadable'})`);
      continue;
    }
    let st: Stats;
    try {
      st = statSync(abs);
    } catch {
      blocks.push(`${p}: (not found)`);
      continue;
    }
    if (st.isDirectory()) {
      // Bounded, synchronous listing — the mention picker runs on user action and
      // is capped, so it stays sync (unlike the agentic glob tool).
      const files: string[] = [];
      for (const f of walkFiles(abs)) {
        files.push(toPosix(relative(abs, f)));
        if (files.length >= 100) break;
      }
      blocks.push(
        `Folder ${p} (${files.length} files):\n${files.map((f) => `- ${p}/${f}`).join('\n')}`
      );
    } else {
      try {
        const buf = readFileSync(abs);
        if (buf.includes(0)) {
          blocks.push(`File ${p}: (binary, skipped)`);
          continue;
        }
        const truncated = buf.length > args.maxBytes;
        const text = buf.subarray(0, args.maxBytes).toString('utf8');
        blocks.push(
          `File ${p}:\n\`\`\`\n${text}${truncated ? `\n…(truncated, ${buf.length} bytes total)` : ''}\n\`\`\``
        );
      } catch (err) {
        blocks.push(`File ${p}: (error — ${err instanceof Error ? err.message : 'unreadable'})`);
      }
    }
  }
  if (blocks.length === 0) return '';
  return `The user attached the following files/folders as context:\n\n${blocks.join('\n\n')}`;
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
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // never traverse out of the workspace via a link
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name) && !name.startsWith('.')) stack.push(full);
      } else if (st.isFile()) {
        yield full;
        if (++count >= MAX_WALK_FILES) return;
      }
    }
  }
}

/**
 * Async twin of {@link walkFiles} for the agentic glob/search tools. Awaiting
 * `readdir`/`stat` hands control back to the event loop between filesystem ops,
 * so a large scan never freezes the Electron main process (and the PTYs that
 * stream through it). The synchronous walker is kept for the bounded, one-shot
 * `@`-mention context build.
 */
async function* walkFilesAsync(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  let count = 0;
  const stack = [root];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // unreadable dir — skip
    }
    for (const name of entries) {
      signal?.throwIfAborted(); // honor Stop mid-scan instead of walking to MAX_WALK_FILES
      const full = join(dir, name);
      let st: Stats;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // never traverse out of the workspace via a link
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
export async function globTool(args: {
  pattern: string;
  path?: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const root = assertReadablePath(args.path ?? '.', args.cwd);
  const re = globToRegExp(args.pattern);
  const matches: string[] = [];
  for await (const file of walkFilesAsync(root, args.signal)) {
    const rel = toPosix(relative(root, file));
    if (re.test(rel) || re.test(toPosix(relative(root, file).split(sep).pop() ?? ''))) {
      matches.push(rel);
      if (matches.length >= MAX_GLOB_RESULTS) break;
    }
  }
  return matches;
}

/** search: regex content search across files, optionally filtered by glob. */
export async function searchTool(args: {
  regex: string;
  path?: string;
  glob?: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<Array<{ file: string; line: number; text: string }>> {
  const root = assertReadablePath(args.path ?? '.', args.cwd);
  const re = new RegExp(args.regex);
  const globRe = args.glob ? globToRegExp(args.glob) : null;
  const out: Array<{ file: string; line: number; text: string }> = [];
  for await (const file of walkFilesAsync(root, args.signal)) {
    const rel = toPosix(relative(root, file));
    if (globRe && !globRe.test(rel)) continue;
    let buf: Buffer;
    try {
      const st = await lstat(file);
      if (st.size > MAX_FILE_BYTES) continue;
      buf = await readFile(file);
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
