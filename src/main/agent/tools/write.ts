import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentToolResult, WriteArgs } from '../../../shared/agent-tools';
import { splitLines } from '../../../shared/agent-diff';
import { displayPath, resolveInsideCwd } from './paths';
import { diffReport } from './edit';
import { requireFresh } from './freshness';
import { checkEditableSize, readTextFile, writeTextFile } from './text-file';

/**
 * Create a file, or replace one.
 *
 * Two operations that look like one. Creating is safe - there is nothing to
 * lose - and reports only that it happened, since echoing back the lines the
 * model just wrote buys nothing. Replacing can destroy work, so it goes through
 * the same guard as an edit: the file has to have been read, and has to be
 * unchanged since, and what comes back is a diff of what the rewrite actually
 * did to it.
 */
export async function runWrite(args: WriteArgs, cwd: string): Promise<AgentToolResult> {
  const abs = resolveInsideCwd(args.path, cwd);
  const shown = displayPath(abs, cwd);
  const info = await stat(abs).catch(() => null);

  if (info === null) {
    await mkdir(dirname(abs), { recursive: true });
    await writeTextFile(abs, args.content, false);
    const lines = splitLines(args.content).length;
    return {
      text: `Created ${shown} (${lines} line${lines === 1 ? '' : 's'}). The user is shown the file you wrote, so do not repeat its contents in your reply.`,
      summary: `${lines} line${lines === 1 ? '' : 's'}`
    };
  }

  if (info.isDirectory()) throw new Error(`${shown} is a folder, not a file`);
  checkEditableSize(info.size, shown);
  requireFresh(abs, info, shown);

  const before = await readTextFile(abs, shown);
  if (before.text === args.content) {
    return { text: `${shown} already contains exactly that`, summary: 'no change' };
  }

  await writeTextFile(abs, args.content, before.crlf);
  // A rewrite that lands on an existing file is the case worth a word: it is
  // the one call here that can quietly delete work, and the model chose it over
  // the tool that cannot.
  return diffReport(`Rewrote ${shown}`, before.text, args.content, [
    'That replaced the whole file. Use edit to change part of one - it cannot drop what you did not repeat.'
  ]);
}
