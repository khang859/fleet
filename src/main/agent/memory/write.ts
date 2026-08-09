import { readFile, stat } from 'node:fs/promises';
import { MemoryFrontmatter, type MemoryWriteArgsFields } from '../../../shared/agent-memory';
import type { AgentToolResult } from '../../../shared/agent-tools';
import { diffReport } from '../tools/edit';
import { remember, requireFresh } from '../tools/freshness';
import { resolveInsideCwd } from '../tools/paths';
import { writeFrontmatterFile } from '../markdown-definitions-write';
import { projectMemoryDir, userMemoryDir } from './definitions';

/**
 * Recording one fact, or correcting one.
 *
 * The rule is `write`'s, applied to a different kind of file. Creating is safe -
 * there is nothing to lose - and reports only that it happened. Replacing can
 * destroy something the agent has no way to get back, so it goes through the
 * same guard an edit does: the entry has to have been read in this conversation,
 * and what comes back is a diff of what the rewrite actually did to it.
 *
 * That pairing is what makes "no delete tool" liveable. The model cannot erase
 * an entry, but it can correct one it has just read, and the correction is
 * visible in the transcript as a diff rather than as a claim that it happened.
 *
 * Confinement is `resolveInsideCwd` against the tier's own folder rather than
 * against the working folder, exactly as `tools/skill.ts` resolves a bundled
 * file against the skill's folder. The parameter is called `cwd` and it is a
 * root. Without that, a user-tier entry would be unwritable, since `~/.fleet`
 * is not inside the project the pane was opened on.
 */
export async function writeMemoryEntry(
  args: MemoryWriteArgsFields,
  ctx: { cwd: string; threadId: string }
): Promise<AgentToolResult> {
  const root = args.scope === 'project' ? projectMemoryDir(ctx.cwd) : userMemoryDir();
  // The name is already `[a-z0-9-]+` by the time it gets here, so this cannot
  // walk anywhere. It is checked anyway, because a schema being right is not the
  // same as a path being confined, and the two are edited by different people.
  const abs = resolveInsideCwd(`${args.name}.md`, root);
  const shown = `the "${args.name}" memory`;

  const info = await stat(abs).catch(() => null);
  const before = info === null ? null : await readFile(abs, 'utf8');
  if (info !== null) requireFresh(ctx.threadId, abs, info, shown);

  const contents = await writeFrontmatterFile(
    abs,
    { name: args.name, description: args.description },
    args.body,
    MemoryFrontmatter,
    'memory'
  );
  // Having written a file is knowing what is in it, the same reasoning
  // `writeTextFile` uses: a second correction in the same turn should not need
  // a read in between.
  remember(ctx.threadId, abs, await stat(abs));

  if (before === null) {
    return {
      text: `Remembered as "${args.name}", in ${args.scope === 'project' ? 'this project' : "the user's own notes"}. It joins your roster from the next turn on, so there is nothing to read back now. The user can see it and remove it in Settings.`,
      summary: 'recorded'
    };
  }
  return diffReport(`Rewrote ${shown}`, before, contents);
}
