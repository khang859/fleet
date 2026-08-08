import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { FoundSkill, SkillFoundIn, SkillStatus } from '../../../shared/agent-skill-install';
import type { SkillDefinition } from '../../../shared/agent-skills';
import { loadFrom, userSkillsDir } from './definitions';

/**
 * Skills already on this machine, in somebody else's folder.
 *
 * The format is shared, so a user who has used any other agent for a week
 * already owns skills Fleet cannot see. Offering those is worth more on the
 * first day than anything downloadable, and costs a directory walk.
 *
 * Re-runnable rather than a migration. Somebody who writes a skill in Claude
 * Code next month should be able to come back and see it offered, with the ones
 * they already took marked as taken - which is why every row carries a status
 * rather than the list being filtered down to what is new.
 */

/** One place skills are kept, and whose it is. */
type Root = { foundIn: SkillFoundIn; scope: 'user' | 'project'; dir: string };

/**
 * Everywhere worth looking.
 *
 * The user roots are the three tools' own, plus `~/.agents/skills`, which is the
 * neutral location the format defines for exactly this - a folder that is not
 * any one agent's. The project roots are the same idea inside a repo, which is
 * where a team keeps the skills that come with a clone.
 *
 * Fleet's own folder is not scanned. What is in it is already loaded.
 */
export function scanRoots(cwd: string): Root[] {
  const home = homedir();
  return [
    { foundIn: 'claude-code', scope: 'user', dir: join(home, '.claude', 'skills') },
    { foundIn: 'opencode', scope: 'user', dir: join(home, '.config', 'opencode', 'skills') },
    { foundIn: 'agents', scope: 'user', dir: join(home, '.agents', 'skills') },
    { foundIn: 'claude-code', scope: 'project', dir: join(cwd, '.claude', 'skills') },
    { foundIn: 'opencode', scope: 'project', dir: join(cwd, '.opencode', 'skills') },
    { foundIn: 'agents', scope: 'project', dir: join(cwd, '.agents', 'skills') }
  ];
}

/** What every other tool on this machine has, and how it compares to ours. */
export async function detectSkills(cwd: string): Promise<FoundSkill[]> {
  const installed = await installedDigests();
  const found: FoundSkill[] = [];

  for (const root of scanRoots(cwd)) {
    // One source per call, so nothing is deduplicated across roots: two tools
    // both having a `commit-style` is common, and which one you want is a
    // question only the user can answer. Both rows are shown.
    for (const skill of await loadFrom([[root.scope, root.dir]])) {
      found.push({
        name: skill.name,
        description: skill.description,
        origin: {
          foundIn: root.foundIn,
          scope: root.scope,
          root: root.dir,
          path: skill.dir,
          from: ''
        },
        status: compare(installed, skill)
      });
    }
  }
  return found;
}

/** The same shape, for the skills in a folder that was just cloned. */
export async function readCloned(dir: string, from: string): Promise<FoundSkill[]> {
  const installed = await installedDigests();
  return (await loadFrom([['user', dir]])).map((skill) => ({
    name: skill.name,
    description: skill.description,
    origin: {
      foundIn: 'git' as const,
      scope: 'user' as const,
      root: dir,
      path: skill.dir,
      from
    },
    status: compare(installed, skill)
  }));
}

/**
 * Whether the copy we hold is this one.
 *
 * A digest of the `SKILL.md` text rather than a field-by-field comparison. The
 * body is the skill - a change to it is the whole change - and hashing the file
 * means a skill that gains a `references/` folder upstream still reads as the
 * same skill, which is the answer a user wants when deciding whether to
 * overwrite what they have.
 */
function compare(installed: Map<string, string>, skill: SkillDefinition): SkillStatus {
  const held = installed.get(skill.name);
  if (held === undefined) return 'new';
  return held === digest(skill.body) ? 'known' : 'changed';
}

function digest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** What is in `~/.fleet/skills` now, by name. */
async function installedDigests(): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  for (const skill of await loadFrom([['user', userSkillsDir()]])) {
    held.set(skill.name, digest(skill.body));
  }
  return held;
}

/**
 * Whether a folder is one this scan would have offered.
 *
 * The check `install` makes before copying anything. A path arrives from the
 * renderer, and "copy this folder into the user's skills" is not a thing to do
 * with an arbitrary one - so it has to be under a root we ourselves named, and
 * be a direct child of it rather than something reached by walking up out of it.
 */
export function isUnderRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => join(root, basename(path)) === path);
}

/** The `SKILL.md` in a folder, for the copy step to check before it starts. */
export async function readEntry(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
}
