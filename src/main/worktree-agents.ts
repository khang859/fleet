import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { WORKTREE_AGENTS, type AgentChoice } from '../shared/agents';
import { isWslContext, type PathContext } from '../shared/shell-profiles';
import { enrichProcessEnv } from './shell-env';

/** Whether `command` is in a folder on PATH, with its Windows extensions. */
function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '').split(';') : [''];
  const folders = (env.PATH ?? '').split(delimiter);

  return folders.some((folder) =>
    extensions.some((extension) => existsSync(join(folder, `${command}${extension}`)))
  );
}

/**
 * The known agents this machine does not have. A WSL distro has its own PATH,
 * so none is listed for it. Waits for the login shell's PATH: an app started
 * from the Dock does not have it at launch.
 */
export async function missingAgents(
  ctx: PathContext | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<AgentChoice[]> {
  if (isWslContext(ctx)) return [];

  await enrichProcessEnv();
  return WORKTREE_AGENTS.filter((agent) => !onPath(agent.command, env)).map((agent) => agent.id);
}
