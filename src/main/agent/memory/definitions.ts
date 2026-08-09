import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  MemoryFrontmatter,
  type MemoryDefinition,
  type MemorySource
} from '../../../shared/agent-memory';
import { loadDefinitions } from '../markdown-definitions';
import { createLogger } from '../../logger';

const log = createLogger('agent:memory');

/**
 * Memory entries, read off disk.
 *
 * The walk is `../markdown-definitions`, shared with subagents, commands and
 * skills. What is here is only what makes a memory a memory: where the two
 * folders are, and the rule that a file's name must be its `name`.
 *
 * Two tiers rather than three. There is no bundled tier because Fleet ships no
 * memory - an entry only exists because a session wrote it - and a tier with
 * nothing in it forever is a tier worth not having.
 *
 * Nothing caches, the same as everywhere else on disk. That is what makes an
 * entry written in the middle of one turn part of the roster on the next one,
 * with no invalidation step anywhere.
 */

/** Where a folder of entries sits, relative to a project or a home dir. */
const MEMORY_SUBDIR = join('.fleet', 'memory');

/** Where an entry the agent records for the user goes. */
export function userMemoryDir(): string {
  return join(homedir(), MEMORY_SUBDIR);
}

/** Where an entry the agent records about a project goes. */
export function projectMemoryDir(cwd: string): string {
  return join(cwd, MEMORY_SUBDIR);
}

/** Every entry available to a pane open on `cwd`. */
export async function loadMemory(cwd: string): Promise<MemoryDefinition[]> {
  // Least specific first, so a project entry of the same name wins - the repo
  // gets to correct something the user believed in general.
  return loadFrom([
    ['user', userMemoryDir()],
    ['project', projectMemoryDir(cwd)]
  ]);
}

/** The same, from folders stated outright. Exported for tests. */
export async function loadFrom(
  sources: Array<[MemorySource, string]>
): Promise<MemoryDefinition[]> {
  return loadDefinitions(sources, {
    kind: 'memory',
    schema: MemoryFrontmatter,
    log,
    build: ({ frontmatter, body, source, path }) => {
      // `memory_write` addresses an entry by name and turns that name straight
      // into a path, so the two have to agree. Without this rule a hand-written
      // `notes.md` saying `name: foo` and a later write of `foo` would leave two
      // files claiming one name, and which one the model read would come down to
      // the order `readdir` happened to return them in.
      const file = basename(path, '.md');
      if (frontmatter.name !== file) {
        log.warn(
          `${path} is called "${frontmatter.name}" but is named "${file}.md"; the two must match, skipping`
        );
        return null;
      }
      return {
        name: frontmatter.name,
        description: frontmatter.description,
        body,
        // The walk speaks of three tiers because the three older kinds have
        // three. The sources above are the only ones this is reachable through,
        // so the alternative to `project` is `user`.
        source: source === 'project' ? 'project' : 'user',
        path
      };
    }
  });
}
