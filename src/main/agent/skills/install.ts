import { cp, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  InstalledSkill,
  SkillInstallOutcome,
  SkillPickFields
} from '../../../shared/agent-skill-install';
import { createLogger } from '../../logger';
import { loadFrom, userSkillsDir } from './definitions';
import { isUnderRoot, readEntry } from './scan';

const log = createLogger('agent:skills:install');

/**
 * Copying a skill into `~/.fleet/skills`.
 *
 * A copy rather than a link or a reference, which is the same bargain the MCP
 * import makes and is worth restating: once it is here it is the user's. Editing
 * it does not change anything for Claude Code, and Claude Code shipping a new
 * version does not silently change what this agent does. The price is that the
 * two drift, which is why the scan reports `changed` rather than pretending they
 * are in sync.
 *
 * The whole folder comes across, not just `SKILL.md`. `scripts/`, `references/`
 * and `assets/` are what makes a skill more than a paragraph, and a skill whose
 * body says "run scripts/check.sh" is broken by an install that left it behind.
 */

/** Bytes one skill folder may be. Past this it is a repository, not a skill. */
const MAX_SKILL_BYTES = 20_000_000;

/**
 * Take the picked folders.
 *
 * `roots` is every folder the offer could legitimately have come from - the scan
 * roots and any live clone. A path outside them is refused rather than copied:
 * what arrives here came from the renderer, and "copy this directory into the
 * user's skills folder" is not an instruction to carry out on an arbitrary one.
 *
 * One failure does not stop the others. A user who ticked six and can have five
 * wants the five, plus a line about the sixth.
 */
export async function installSkills(
  picks: SkillPickFields[],
  roots: string[]
): Promise<SkillInstallOutcome> {
  const target = userSkillsDir();
  await mkdir(target, { recursive: true });

  const installed: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];

  for (const pick of picks) {
    try {
      await installOne(pick, roots, target);
      installed.push(pick.name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn(`could not install ${pick.name}`, { path: pick.path, reason });
      failed.push({ name: pick.name, reason });
    }
  }

  return { installed, failed };
}

async function installOne(pick: SkillPickFields, roots: string[], target: string): Promise<void> {
  if (!isUnderRoot(pick.path, roots)) {
    throw new Error('that folder is not one Fleet offered');
  }
  // The folder name is what the skill will be called, and the loader requires it
  // to match the frontmatter. Taking it from the path rather than from `name`
  // means the renderer cannot ask for a folder to land under a different name.
  const folder = basename(pick.path);
  if (folder !== pick.name) {
    throw new Error('its folder and its name disagree');
  }

  if ((await readEntry(pick.path)) === null) {
    throw new Error('there is no SKILL.md in it');
  }

  // The real folder, because the offered one may be a link to it. Keeping a
  // skill in a repository and linking it into `~/.claude/skills` is a thing
  // people genuinely do, so the link is worth following - but only here, to find
  // what to read. Copying the *link* would leave `~/.fleet/skills/x` pointing at
  // somebody else's directory, and then this is not a copy at all: the skill
  // Fleet loads would keep changing whenever that directory did, which is the
  // one thing installing rather than referencing is supposed to prevent.
  const from = await realpath(pick.path);

  const size = await folderBytes(from);
  if (size > MAX_SKILL_BYTES) {
    throw new Error(`it is ${Math.round(size / 1_000_000)}MB, which is too large for a skill`);
  }

  // Replace rather than merge. A merge would leave files from the old version
  // beside the new one, and a skill whose body no longer mentions them is a
  // skill carrying files nobody will ever look at or think to delete.
  const dest = join(target, folder);
  await rm(dest, { recursive: true, force: true });
  await cp(from, dest, {
    recursive: true,
    // Every link *inside* the folder is dropped, having already dereferenced the
    // folder itself. One pointing outside would reproduce the same tie this just
    // undid, one level down; one pointing inside would either duplicate a file
    // that is being copied anyway or, if absolute, still point at the original.
    // None of the three is a copy, and a skill is text and scripts.
    dereference: false,
    filter: async (source) => {
      if (basename(source).startsWith('.git')) return false;
      const info = await lstat(source).catch(() => null);
      return info !== null && !info.isSymbolicLink();
    }
  });

  log.info(`installed skill ${folder}`, { from, to: dest });
}

/** What is already installed, for the settings list. */
export async function listInstalled(): Promise<InstalledSkill[]> {
  return (await loadFrom([['user', userSkillsDir()]])).map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: skill.dir
  }));
}

/** Remove an installed skill. Only ever from Fleet's own folder. */
export async function removeSkill(name: string): Promise<void> {
  const target = userSkillsDir();
  const dir = join(target, name);
  // Rebuilt from the name rather than taken as a path, so the worst a bad name
  // can do is fail to match a folder.
  if (basename(dir) !== name || join(target, basename(dir)) !== dir) {
    throw new Error(`"${name}" is not a skill name`);
  }
  await rm(dir, { recursive: true, force: true });
  log.info(`removed skill ${name}`, { path: dir });
}

/** Total size of a folder, stopping once it is clearly too big to matter. */
async function folderBytes(dir: string): Promise<number> {
  let total = 0;

  const walk = async (at: string): Promise<void> => {
    if (total > MAX_SKILL_BYTES) return;
    let names: string[];
    try {
      names = await readdir(at);
    } catch {
      return;
    }
    for (const name of names) {
      if (total > MAX_SKILL_BYTES) return;
      const path = join(at, name);
      // `lstat` rather than `stat`, so a link is not counted as whatever it
      // points at. The copy drops links, so a link to something enormous costs
      // nothing, and following one here would refuse an install over bytes that
      // are never going to be written.
      const info = await lstat(path).catch(() => null);
      if (info === null) continue;
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) total += info.size;
    }
  };

  await walk(dir);
  return total;
}
