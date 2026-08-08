import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { SubagentFrontmatter, type SubagentDefinition } from '../../../shared/agent-subagents';
import { loadDefinitions, type DefinitionSource } from '../markdown-definitions';
import { createLogger } from '../../logger';

const log = createLogger('agent:subagents');

/**
 * Subagent definitions, read off disk.
 *
 * Files rather than settings, because a subagent is a prompt, and a prompt is
 * something you edit, diff, and review. The project ones live in the repo, so
 * "the reviewer this team uses" arrives with a clone instead of with a list of
 * setup instructions, and a change to it goes through the same review as a
 * change to anything else.
 *
 * The walk itself is `../markdown-definitions`, shared with commands. What is
 * here is only what makes a subagent a subagent.
 */

/** Where a folder of definitions sits, relative to a project or a home dir. */
const AGENTS_SUBDIR = join('.fleet', 'agents');

/**
 * The ones that ship with the app.
 *
 * Packaged builds get an `extraResources` copy rather than the asar, because a
 * path inside `app.asar` is not a path `readdir` can walk - see
 * `docs/learnings/2026-06-28-chat-skills-missing-from-packaged-app.md`, where
 * exactly this shipped broken once already.
 *
 * The dev branch is relative to the *bundle*, `out/main/index.mjs`, not to this
 * source file - the same two hops `index.ts` uses to find `resources/`. Counting
 * from the source layout instead gives a path that is right under vitest and
 * wrong in the app, which is the one way this can be wrong and still look tested.
 */
function bundledDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'agents')
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'agents');
}

/** Every definition available to a pane open on `cwd`. */
export async function loadSubagents(cwd: string): Promise<SubagentDefinition[]> {
  // Least specific first, so a more specific one of the same name overwrites.
  return loadFrom([
    ['bundled', bundledDir()],
    ['user', join(homedir(), AGENTS_SUBDIR)],
    ['project', join(cwd, AGENTS_SUBDIR)]
  ]);
}

/** The same, from folders stated outright. Exported for tests. */
export async function loadFrom(
  sources: Array<[DefinitionSource, string]>
): Promise<SubagentDefinition[]> {
  return loadDefinitions(sources, {
    kind: 'subagent',
    schema: SubagentFrontmatter,
    log,
    build: ({ frontmatter, body, source, path }) => ({
      name: frontmatter.name,
      description: frontmatter.description,
      model: frontmatter.model,
      tools: frontmatter.tools ?? null,
      systemPrompt: body,
      source,
      path
    })
  });
}
