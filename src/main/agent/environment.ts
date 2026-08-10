import { release, type } from 'node:os';
import type { AgentEnvironment } from '../../shared/agent-environment';
import { getDefaultShell } from '../shell-detection';
import { resolveGitDir } from './git-head';

/**
 * Reading the machine, so `shared/agent-environment.ts` can say what it is.
 *
 * Everything here is either a process constant or a file read. `isGitRepo` is
 * the only part that touches the disk, and it goes through `resolveGitDir` -
 * the same bounded walk the status line uses, which spawns nothing. See
 * `shared/agent-git.ts` for why that matters in a GUI-launched Electron app.
 *
 * Called once per turn rather than cached. The platform will not have changed,
 * but the folder can - a pane can be pointed somewhere else, and `git init` is
 * a thing that happens mid-conversation - and a cache keyed on the folder would
 * be machinery guarding a walk of at most forty `access` calls.
 */
export async function readEnvironment(cwd: string, model: string): Promise<AgentEnvironment> {
  return {
    platform: process.platform,
    // Kernel rather than product version: `os.release()` is what is actually
    // knowable without spawning `sw_vers`, and it is what a command deciding
    // between BSD and GNU flags is really asking about.
    osVersion: `${type()} ${release()}`,
    shell: getDefaultShell(),
    isGitRepo: (await resolveGitDir(cwd)) !== null,
    // Where the user's clock is, from the same source the clock is read from.
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    model
  };
}
