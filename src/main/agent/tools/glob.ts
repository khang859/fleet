import { stat } from 'node:fs/promises';
import {
  GLOB_MAX_RESULTS,
  GREP_MAX_FILES,
  type AgentToolContext,
  type AgentToolResult,
  type GlobArgs
} from '../../../shared/agent-tools';
import { displayPath, resolveInsideCwd } from './paths';
import { globMatcher } from './glob-match';
import { walkFiles } from './walk';

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

  const stamped = await Promise.all(
    found.map(async (abs) => ({
      abs,
      mtimeMs: await stat(abs)
        .then((s) => s.mtimeMs)
        .catch(() => 0)
    }))
  );
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (stamped.length === 0) {
    const scope = walked.truncated ? ' (the search stopped early - narrow `path`)' : '';
    return { text: `No files match ${args.pattern}${scope}`, summary: 'no files' };
  }

  const shown = stamped.slice(0, GLOB_MAX_RESULTS).map((f) => displayPath(f.abs, cwd));
  const trailer =
    stamped.length > GLOB_MAX_RESULTS
      ? `\n\n… ${stamped.length - GLOB_MAX_RESULTS} more, newest shown first. Narrow the pattern to see the rest.`
      : '';

  return {
    text: `${stamped.length} file${stamped.length === 1 ? '' : 's'} matching ${args.pattern}, newest first:\n${shown.join('\n')}${trailer}`,
    summary: `${stamped.length} file${stamped.length === 1 ? '' : 's'}`
  };
}
