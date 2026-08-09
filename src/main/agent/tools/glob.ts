import { stat } from 'node:fs/promises';
import {
  GLOB_MAX_RESULTS,
  GREP_MAX_FILES,
  type AgentToolContext,
  type AgentToolResult,
  type GlobArgs
} from '../../../shared/agent-tools';
import { displayPathIn, resolveInsideCwd } from './paths';
import { globMatcher } from './glob-match';
import { walkFiles } from './walk';

/**
 * Files stat'd at once.
 *
 * Node serves `stat` from a thread pool four threads wide, shared by every
 * other thing in the process that touches a disk. Asking for twenty thousand at
 * once does not make them faster - it fills that queue, and the reads a
 * terminal or a session log is waiting on land behind all of them.
 */
const STAT_POOL = 32;

/**
 * Find files by path.
 *
 * Ordered by modification time, newest first, because the question behind a
 * glob is almost never "what exists" - it is "what is being worked on". The
 * file touched an hour ago is the one the conversation is about, and putting it
 * at the top of a truncated list is the difference between a useful answer and
 * an alphabetical accident.
 */
export async function runGlob(args: GlobArgs, { cwd }: AgentToolContext): Promise<AgentToolResult> {
  const root = resolveInsideCwd(args.path ?? '.', cwd);
  const matches = globMatcher(args.pattern);
  const found: string[] = [];

  const walked = await walkFiles(root, GREP_MAX_FILES, (file) => {
    if (matches(file.rel)) found.push(file.abs);
  });

  const stamped = found.map((abs) => ({ abs, mtimeMs: 0 }));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(STAT_POOL, stamped.length) }, async () => {
      for (let i = next++; i < stamped.length; i = next++) {
        // A file that vanished between the walk and the stat sorts last rather
        // than dropping out: it was there a moment ago, and the walk is what
        // says it matched.
        stamped[i].mtimeMs = await stat(stamped[i].abs)
          .then((s) => s.mtimeMs)
          .catch(() => 0);
      }
    })
  );
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (stamped.length === 0) {
    const scope = walked.truncated ? ' (the search stopped early - narrow `path`)' : '';
    return { text: `No files match ${args.pattern}${scope}`, summary: 'no files' };
  }

  const shownPath = displayPathIn(cwd);
  const shown = stamped.slice(0, GLOB_MAX_RESULTS).map((f) => shownPath(f.abs));
  const trailer =
    stamped.length > GLOB_MAX_RESULTS
      ? `\n\n… ${stamped.length - GLOB_MAX_RESULTS} more, newest shown first. Narrow the pattern to see the rest.`
      : '';

  return {
    text: `${stamped.length} file${stamped.length === 1 ? '' : 's'} matching ${args.pattern}, newest first:\n${shown.join('\n')}${trailer}`,
    summary: `${stamped.length} file${stamped.length === 1 ? '' : 's'}`
  };
}
