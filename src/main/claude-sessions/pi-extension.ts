import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomicSync } from '../fs-atomic';
import { createLogger } from '../logger';

const log = createLogger('claude-sessions:pi-extension');

/** In the first line of the extension, so Fleet never touches a user's own `fleet.js`. */
const MARKER = 'fleet-managed';

/** Pi's config folder. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.PI_CODING_AGENT_DIR ?? join(home, '.pi', 'agent');
}

/** Whether Pi has run on this machine. */
export function piInstalled(agentDir = piAgentDir()): boolean {
  return existsSync(agentDir);
}

function extensionPath(agentDir: string): string {
  return join(agentDir, 'extensions', 'fleet.js');
}

function isFleets(text: string): boolean {
  return text.split('\n', 1)[0].includes(MARKER);
}

/** Where the extension Fleet ships is, or null when it is not found. */
export function bundledExtensionPath(): string | null {
  const mainDir = dirname(fileURLToPath(import.meta.url));
  const source = [
    join(mainDir, '..', '..', 'resources', 'pi-extensions', 'fleet.js'),
    join(process.resourcesPath, 'resources', 'pi-extensions', 'fleet.js')
  ].find((path) => existsSync(path));
  return source ?? null;
}

/** The extension Fleet ships, or null when it is not found. */
function bundledExtension(): string | null {
  const source = bundledExtensionPath();
  return source ? readFileSync(source, 'utf8') : null;
}

/**
 * Put the extension where Pi discovers it, only when its text changed. Skipped
 * when Pi was never run. Throws when a file of the user's has that name.
 */
export function ensurePiExtension(agentDir = piAgentDir(), text = bundledExtension()): void {
  if (!text || !piInstalled(agentDir)) return;
  const path = extensionPath(agentDir);
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    if (!isFleets(current)) throw new Error(`${path} is not Fleet's, so Fleet left it alone`);
    if (current === text) return;
  }
  writeAtomicSync(path, text);
  log.info('pi extension installed', { path });
}

/** Remove the extension, if the file there is Fleet's. */
export function removePiExtension(agentDir = piAgentDir()): void {
  const path = extensionPath(agentDir);
  if (existsSync(path) && isFleets(readFileSync(path, 'utf8'))) rmSync(path);
}
