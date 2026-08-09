import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ipcMain, shell } from 'electron';
import { z } from 'zod';
import {
  MEMORY_SCOPES,
  MemoryFrontmatter,
  type MemoryDescriptor
} from '../../../shared/agent-memory';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { createLogger } from '../../logger';
import { loadMemory, projectMemoryDir, userMemoryDir } from './definitions';

const log = createLogger('agent:memory:ipc');

/**
 * The renderer's way in.
 *
 * Three handles where skills have seven, and what is missing is the design. No
 * create, no import, no fetch: the only thing that writes an entry is the agent
 * in the middle of a turn, so Settings is a place to see what it wrote and take
 * one back, not a second way to author them.
 *
 * `list` takes the working folder because the project tier is per-folder, and it
 * reads from disk on every call rather than from anything cached - which is what
 * makes an entry written mid-turn show up in the panel without a single
 * invalidation step anywhere.
 *
 * `remove` rebuilds the path from the tier and the name rather than taking one,
 * the way `removeSkill` does. A path that arrived over IPC is an argument, and
 * "delete this file" is not an instruction to carry out on an arbitrary one.
 */

const Cwd = z.string().min(1);
const Scope = z.enum(MEMORY_SCOPES);
/** The same name the frontmatter allows, which is what keeps it a filename. */
const Name = MemoryFrontmatter.shape.name;

export function registerAgentMemoryIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.AGENT_MEMORY_LIST,
    async (_e, cwd: unknown): Promise<MemoryDescriptor[]> =>
      (await loadMemory(Cwd.parse(cwd))).map(({ name, description, source, path }) => ({
        name,
        description,
        source,
        path
      }))
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_MEMORY_REMOVE,
    async (_e, scope: unknown, name: unknown, cwd: unknown): Promise<void> => {
      const parsed = Name.parse(name);
      const root =
        Scope.parse(scope) === 'project' ? projectMemoryDir(Cwd.parse(cwd)) : userMemoryDir();
      const path = join(root, `${parsed}.md`);
      // Belt and braces over the name pattern above: a name that somehow got
      // past it still cannot name a file outside the folder it was built from.
      if (basename(path) !== `${parsed}.md`) throw new Error(`"${parsed}" is not a memory name`);
      await rm(path, { force: true });
      log.info(`removed memory ${parsed}`, { path });
    }
  );

  // The escape hatch for everything this panel does not do: reading the whole
  // entry, editing one by hand, writing one yourself.
  ipcMain.handle(IPC_CHANNELS.AGENT_MEMORY_REVEAL, (_e, path: unknown) => {
    shell.showItemInFolder(z.string().min(1).parse(path));
  });
}
