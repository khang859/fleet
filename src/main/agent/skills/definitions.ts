import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { SkillFrontmatter, type SkillDefinition } from '../../../shared/agent-skills';
import { loadFolderDefinitions, type DefinitionSource } from '../markdown-definitions';
import { createLogger } from '../../logger';

const log = createLogger('agent:skills');

/**
 * Skill definitions, read off disk.
 *
 * The walk is `../markdown-definitions`, shared with commands and subagents.
 * What is here is only what makes a skill a skill: that it is a folder rather
 * than a file, where those folders live, and the one rule the format has that
 * the frontmatter schema cannot check on its own.
 */

/** Where a folder of skills sits, relative to a project or a home dir. */
const SKILLS_SUBDIR = join('.fleet', 'skills');

/** The file that makes a folder a skill. Fixed by the format, not by Fleet. */
const ENTRY = 'SKILL.md';

/**
 * The ones that ship with the app.
 *
 * Two hops, counted from the *bundle* at `out/main/index.mjs` rather than from
 * this source file, and an `extraResources` copy in packaged builds because
 * `readdir` cannot walk into `app.asar`. Both of those have shipped broken
 * before - see `docs/learnings/2026-08-07-bundled-resource-path-from-the-bundle-not-the-source.md`
 * and `docs/learnings/2026-06-28-chat-skills-missing-from-packaged-app.md` - and
 * both fail the same quiet way, with `readdir` throwing and the feature simply
 * not being offered. Copied from `commands/definitions.ts`; do not recount it.
 */
function bundledDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'skills')
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'skills');
}

/** Where a skill the user installs is written. */
export function userSkillsDir(): string {
  return join(homedir(), SKILLS_SUBDIR);
}

/** Every skill available to a pane open on `cwd`. */
export async function loadSkills(cwd: string): Promise<SkillDefinition[]> {
  // Least specific first, so a more specific one of the same name overwrites.
  return loadFrom([
    ['bundled', bundledDir()],
    ['user', userSkillsDir()],
    ['project', join(cwd, SKILLS_SUBDIR)]
  ]);
}

/** The same, from folders stated outright. Exported for tests. */
export async function loadFrom(
  sources: Array<[DefinitionSource, string]>
): Promise<SkillDefinition[]> {
  return loadFolderDefinitions(sources, ENTRY, {
    kind: 'skill',
    schema: SkillFrontmatter,
    log,
    build: ({ frontmatter, body, source, path, dir }) => {
      // The spec requires the two to match, and it is right to: the folder name
      // is what a user reads in a file listing and what an installer writes,
      // while `name` is what the model types. Two skills whose folders differ
      // but whose frontmatter agrees would collide here silently, with the
      // second quietly replacing the first and no way to tell which won.
      const folder = basename(dir);
      if (frontmatter.name !== folder) {
        log.warn(
          `${path} is called "${frontmatter.name}" but sits in "${folder}"; the two must match, skipping`
        );
        return null;
      }
      return {
        name: frontmatter.name,
        description: frontmatter.description,
        body,
        dir,
        source,
        path
      };
    }
  });
}
