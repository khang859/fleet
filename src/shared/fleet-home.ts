import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Main-process only, and Node.js built-ins only ---
// The `fleet` CLI imports this file, and its copy in ~/.fleet/lib has no
// node_modules to load a package from.

/** The installed app's folder. A dev build only ever reads from it. */
export const RELEASE_FLEET_HOME = join(homedir(), '.fleet');

/**
 * A short, stable id for one checkout: the same folder always gets the same
 * id, and two worktrees never share one.
 */
export function checkoutId(checkoutRoot: string): string {
  return createHash('sha1').update(checkoutRoot).digest('hex').slice(0, 12);
}

/** Where a dev build run from `checkoutRoot` keeps all of its state. */
export function devHomeFor(checkoutRoot: string): string {
  return join(RELEASE_FLEET_HOME, 'dev', checkoutId(checkoutRoot));
}

/**
 * The checkout this code runs from: the nearest folder above it with a
 * `package.json`. Read from the code's own path, not the working directory,
 * so the CLI and child processes started elsewhere still find their checkout,
 * and no environment variable can carry one checkout's answer into another.
 */
export function checkoutRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`no package.json above ${from}`);
    dir = up;
  }
  return dir;
}

export const IS_FLEET_DEV = !!process.env.FLEET_DEV;

const DEV_ID = IS_FLEET_DEV ? checkoutId(checkoutRoot()) : '';

/**
 * Where this Fleet keeps its state. The installed app uses `~/.fleet`; a dev
 * build gets its own folder per checkout, so it never touches the installed
 * app's jobs, panes or sockets, nor another worktree's dev app.
 */
export const FLEET_HOME = DEV_ID ? join(RELEASE_FLEET_HOME, 'dev', DEV_ID) : RELEASE_FLEET_HOME;

function socketPath(name: string): string {
  if (process.platform !== 'win32') return join(FLEET_HOME, `${name}.sock`);
  return `\\\\.\\pipe\\${name}${DEV_ID && `-dev-${DEV_ID}`}`;
}

export const SOCKET_PATH = socketPath('fleet');

export const COPILOT_SOCKET_PATH = socketPath('fleet-copilot');

/** The socket the fleet-bridge Claude Code mod asks for prompts on. Unix only, as the mod reaches it. */
export const BRIDGE_SOCKET_PATH = join(FLEET_HOME, 'fleet-bridge.sock');

/** Where Fleet installs the fleet-bridge mod, a folder Claude Code also writes into. */
export const CLAUDE_MOD_DIR = join(FLEET_HOME, 'claude-mods', 'fleet-bridge');
