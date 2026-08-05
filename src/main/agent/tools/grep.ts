import { readFile, stat } from 'node:fs/promises';
import {
  GREP_MAX_FILES,
  GREP_MAX_MATCHES,
  type AgentToolContext,
  type AgentToolResult,
  type GrepArgs
} from '../../../shared/agent-tools';
import { displayPath, resolveInsideCwd } from './paths';
import { globMatcher } from './glob-match';
import { walkFiles } from './walk';

/**
 * Search file contents.
 *
 * Content is the default output, not a list of file names. The two-step dance -
 * search, then read each hit - costs a round trip and a chunk of context per
 * file, and most searches are answered by the line itself. `files` mode is
 * there for the searches that are really a question about where something
 * lives, where the lines would be noise.
 *
 * The result is capped at a number of matches rather than a number of bytes, and
 * says how many it did not show, so a search that hits everything reads as a
 * search that hits everything rather than as one that found fifty things.
 */

/** Files larger than this are skipped: source code does not look like this. */
const MAX_FILE_BYTES = 5_000_000;

/** How much of one matching line is worth returning. */
const MAX_LINE_CHARS = 300;

/** Files read at once. Enough to keep the disk busy, few enough to keep the descriptors. */
const POOL_SIZE = 16;

/** Matches held before sorting. Well past what is reported, bounded all the same. */
const COLLECT_CAP = 5_000;

type Match = { path: string; line: number; text: string };

export async function runGrep(args: GrepArgs, { cwd }: AgentToolContext): Promise<AgentToolResult> {
  const root = resolveInsideCwd(args.path ?? '.', cwd);
  const pattern = compile(args.pattern, args.ignoreCase ?? false);
  const filter = args.glob === undefined ? null : globMatcher(args.glob);
  const filesOnly = args.mode === 'files';

  const matches: Match[] = [];
  const files = new Set<string>();
  let total = 0;

  const search = async (abs: string, shown: string): Promise<boolean> => {
    const text = await readText(abs);
    if (text === null) return true;

    for (const [index, line] of text.split('\n').entries()) {
      if (!pattern.test(line)) continue;
      total++;
      files.add(shown);
      if (filesOnly) return true;
      // Collected past the reporting cap so the ones reported can be the first
      // by path rather than the first to come back from the disk.
      if (matches.length < COLLECT_CAP) {
        matches.push({ path: shown, line: index + 1, text: clip(line.trim()) });
      }
    }
    return true;
  };

  const single = await stat(root).catch(() => null);
  if (single === null) throw new Error(`${displayPath(root, cwd)} does not exist`);

  let truncated = false;
  if (single.isFile()) {
    await search(root, displayPath(root, cwd));
  } else {
    const candidates: string[] = [];
    const walked = await walkFiles(root, GREP_MAX_FILES, (file) => {
      if (filter === null || filter(file.rel)) candidates.push(file.abs);
    });
    truncated = walked.truncated;
    // A bounded pool rather than one promise per file: a repository has more
    // files than a process has file descriptors.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(POOL_SIZE, candidates.length) }, async () => {
        for (let i = next++; i < candidates.length; i = next++) {
          await search(candidates[i], displayPath(candidates[i], cwd));
        }
      })
    );
  }

  return filesOnly
    ? filesResult(args, files, total, truncated)
    : contentResult(args, matches, files, total, truncated);
}

function contentResult(
  args: GrepArgs,
  matches: Match[],
  files: Set<string>,
  total: number,
  truncated: boolean
): AgentToolResult {
  if (total === 0) return empty(args, truncated);

  // Sorted before it is cut, so which matches are shown does not depend on
  // which file the disk handed back first.
  const ordered = [...matches].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const shown = ordered.slice(0, GREP_MAX_MATCHES);
  const body = shown.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
  const trailer =
    total > shown.length
      ? `\n\n… ${total - shown.length} more matches. Narrow the pattern, or pass mode="files" to see where they are.`
      : '';

  return {
    text: `${count(total, 'match', 'matches')} in ${count(files.size, 'file', 'files')}:\n${body}${trailer}${cutShort(truncated)}`,
    summary: `${count(total, 'match', 'matches')} in ${count(files.size, 'file', 'files')}`
  };
}

function filesResult(
  args: GrepArgs,
  files: Set<string>,
  total: number,
  truncated: boolean
): AgentToolResult {
  if (total === 0) return empty(args, truncated);

  const shown = [...files].sort();
  return {
    text: `${count(files.size, 'file contains', 'files contain')} ${args.pattern}:\n${shown.join('\n')}${cutShort(truncated)}`,
    summary: count(files.size, 'file', 'files')
  };
}

function empty(args: GrepArgs, truncated: boolean): AgentToolResult {
  return {
    text: `No matches for ${args.pattern}${args.glob === undefined ? '' : ` in ${args.glob}`}${cutShort(truncated)}`,
    summary: 'no matches'
  };
}

function cutShort(truncated: boolean): string {
  return truncated
    ? `\n\nThe search stopped after ${GREP_MAX_FILES} files; there is more of this tree to look at.`
    : '';
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The model writes the pattern, so a bad one is an ordinary event: it comes
 * back as a message it can fix rather than as a failed turn.
 */
function compile(pattern: string, ignoreCase: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (err) {
    throw new Error(`${pattern} is not a valid regular expression: ${String(err)}`);
  }
}

/** A file's text, or null when it is too big, unreadable, or not text at all. */
async function readText(abs: string): Promise<string | null> {
  const info = await stat(abs).catch(() => null);
  if (info === null || info.size > MAX_FILE_BYTES) return null;

  const buffer = await readFile(abs).catch(() => null);
  if (buffer === null) return null;
  if (buffer.subarray(0, 8192).includes(0)) return null;
  return buffer.toString('utf8');
}

function clip(line: string): string {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}…`;
}
