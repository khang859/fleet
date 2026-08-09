import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SkillFrontmatter, type SkillWriteArgsFields } from '../../../shared/agent-skills';
import type { AgentToolResult } from '../../../shared/agent-tools';
import { diffReport } from '../tools/edit';
import { remember, requireFresh } from '../tools/freshness';
import { resolveInsideCwd } from '../tools/paths';
import { writeFrontmatterFile } from '../markdown-definitions-write';
import { userSkillsDir } from './definitions';

/**
 * Writing a skill's `SKILL.md`, for `/refine` to reach for when what a session
 * learned is a procedure rather than a fact.
 *
 * The same rule and the same primitive as a memory write: create freely,
 * overwrite only what has been read in this conversation, and report a diff when
 * it replaces something. The freshness half matters more here than there,
 * because a skill is loaded as instructions on every later turn that matches it,
 * so a rewrite has a longer reach than an entry nobody has to read.
 *
 * It writes the entry point only. A skill's `references/` and `scripts/` are
 * things a person assembles, and a tool that could write them would be a tool
 * that can write arbitrary files under an arbitrary name outside the working
 * folder - which is exactly what the path confinement here exists to prevent.
 */
export async function writeSkillBody(
  args: SkillWriteArgsFields,
  ctx: { cwd: string; threadId: string }
): Promise<AgentToolResult> {
  const root = args.scope === 'project' ? join(ctx.cwd, '.fleet', 'skills') : userSkillsDir();
  // Against the tier's own root, the way `tools/skill.ts` resolves a bundled
  // file against the skill's folder. A user-tier skill is not inside the working
  // folder and never will be.
  const abs = resolveInsideCwd(join(args.name, 'SKILL.md'), root);
  const shown = `the "${args.name}" skill`;

  const info = await stat(abs).catch(() => null);
  const before = info === null ? null : await readFile(abs, 'utf8');
  if (info !== null) requireFresh(ctx.threadId, abs, info, shown);

  const contents = await writeFrontmatterFile(
    abs,
    { name: args.name, description: args.description },
    args.body,
    SkillFrontmatter,
    'skill'
  );
  remember(ctx.threadId, abs, await stat(abs));

  if (before === null) {
    return {
      text: `Wrote ${shown} to ${args.scope === 'project' ? 'this project' : "the user's own skills"}. It is offered from the next turn on. The user can see it and remove it in Settings.`,
      summary: 'written'
    };
  }
  return diffReport(`Rewrote ${shown}`, before, contents);
}
