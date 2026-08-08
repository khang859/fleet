import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import {
  AgentCommandFrontmatter,
  RESERVED_COMMAND_NAMES,
  type AgentCommandDefinition
} from '../../../shared/agent-commands';
import { loadDefinitions, type DefinitionSource } from '../markdown-definitions';
import { createLogger } from '../../logger';

const log = createLogger('agent:commands');

/**
 * Command definitions, read off disk.
 *
 * The walk itself is `../markdown-definitions`, shared with subagents. What is
 * here is only what makes a command a command: which folder it lives in, what
 * its frontmatter may say, and the one name it may not take.
 */

/** Where a folder of definitions sits, relative to a project or a home dir. */
const COMMANDS_SUBDIR = join('.fleet', 'commands');

/**
 * The ones that ship with the app.
 *
 * Two hops, counted from the *bundle* at `out/main/index.mjs` rather than from
 * this source file, and an `extraResources` copy in packaged builds because
 * `readdir` cannot walk into `app.asar`. Both of those have shipped broken
 * before - see `docs/learnings/2026-08-07-bundled-resource-path-from-the-bundle-not-the-source.md`
 * and `docs/learnings/2026-06-28-chat-skills-missing-from-packaged-app.md` - and
 * both fail the same quiet way, with `readdir` throwing and the feature simply
 * not being offered. Copy this from `src/main/index.ts`; do not recount it.
 */
function bundledDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'commands')
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'commands');
}

/** Every command available to a pane open on `cwd`. */
export async function loadCommands(cwd: string): Promise<AgentCommandDefinition[]> {
  // Least specific first, so a more specific one of the same name overwrites.
  return loadFrom([
    ['bundled', bundledDir()],
    ['user', join(homedir(), COMMANDS_SUBDIR)],
    ['project', join(cwd, COMMANDS_SUBDIR)]
  ]);
}

/** The same, from folders stated outright. Exported for tests. */
export async function loadFrom(
  sources: Array<[DefinitionSource, string]>
): Promise<AgentCommandDefinition[]> {
  return loadDefinitions(sources, {
    kind: 'command',
    schema: AgentCommandFrontmatter,
    log,
    build: ({ frontmatter, body, source, path }) => {
      if (RESERVED_COMMAND_NAMES.includes(frontmatter.name)) {
        log.warn(`${path} is called "${frontmatter.name}", which Fleet already uses; skipping`);
        return null;
      }
      return {
        name: frontmatter.name,
        description: frontmatter.description,
        template: body,
        source,
        path
      };
    }
  });
}
