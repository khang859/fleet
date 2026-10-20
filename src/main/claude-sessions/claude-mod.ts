import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_SOCKET_PATH, CLAUDE_MOD_DIR } from '../../shared/constants';
import { writeAtomicSync } from '../fs-atomic';
import { createLogger } from '../logger';

const log = createLogger('claude-sessions:claude-mod');

/** The fleet-bridge mod's files, relative to its folder. */
const MOD_FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts'];

/**
 * Copy the fleet-bridge mod (resources/claude-mod/fleet-bridge) to
 * `CLAUDE_MOD_DIR`, where every pane's Claude Code loads it from. Not loaded
 * from the app itself: Claude Code writes type files into a mod's folder, and
 * the app bundle is signed and read-only. Synchronous, so the mod is in place
 * before the first pane starts. Unchanged files are not written, so a running
 * session does not reload the mod for nothing.
 */
export function installClaudeMod(): void {
  const mainDir = dirname(fileURLToPath(import.meta.url));
  const source = [
    join(mainDir, '..', '..', 'resources', 'claude-mod', 'fleet-bridge'),
    join(process.resourcesPath, 'resources', 'claude-mod', 'fleet-bridge')
  ].find((dir) => existsSync(join(dir, MOD_FILES[0])));
  if (!source) {
    log.warn('fleet-bridge mod not found, skipping install');
    return;
  }
  for (const file of MOD_FILES) {
    const text = readFileSync(join(source, file), 'utf8');
    const dest = join(CLAUDE_MOD_DIR, file);
    if (existsSync(dest) && readFileSync(dest, 'utf8') === text) continue;
    writeAtomicSync(dest, text);
  }
}

/** A Fleet mod folder, this Fleet's or another's (dev or not), as a path list names it. */
const FLEET_MOD_DIR = /[\\/]\.fleet[\\/]claude-mods(?:-dev)?[\\/]fleet-bridge$/;

/**
 * The variables that load the mod in a pane's Claude Code and tell it where
 * Fleet listens. Kept out on Windows, where the mod has no socket to reach.
 *
 * A Fleet started from another Fleet's pane inherits that one's mod folder;
 * it is dropped, so one mod asks for the session's prompts, not two.
 */
export function claudeModEnv(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  if (platform === 'win32') return {};
  const dirs = (env.CLAUDE_CODE_PLUGIN_DIRS ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '' && !FLEET_MOD_DIR.test(dir));
  return {
    CLAUDE_CODE_PLUGIN_DIRS: [...dirs, CLAUDE_MOD_DIR].join(delimiter),
    FLEET_BRIDGE_SOCKET: BRIDGE_SOCKET_PATH
  };
}
