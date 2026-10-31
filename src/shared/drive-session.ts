import { join } from 'path';

export interface DriveSession {
  port: number;
  rendererUrl: string;
  pid: number;
}

const PORT_BASE = 31000;
const PORT_PAIRS = 4000;

/**
 * Choose a CDP debug port. Honors a valid FLEET_DEBUG_PORT override, otherwise
 * derives a stable per-checkout port from the app path so parallel dev
 * worktrees do not collide on a shared 9222. The port after it is the
 * checkout's renderer port.
 */
export function deriveDebugPort(appPath: string, override?: string): number {
  if (override && override.trim() !== '') {
    const n = Number(override);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  let hash = 0;
  for (let i = 0; i < appPath.length; i++) {
    hash = (hash * 31 + appPath.charCodeAt(i)) & 0x7fffffff;
  }
  return PORT_BASE + (hash % PORT_PAIRS) * 2;
}

/**
 * The checkout's Vite dev server port. Fixed per checkout, as Vite would
 * otherwise move to the next free port and a dev window could load another
 * checkout's renderer.
 */
export function deriveRendererPort(appPath: string): number {
  return deriveDebugPort(appPath) + 1;
}

/** A path under the checkout's `.fleet-drive/` directory (gitignored). */
export function driveFilePath(cwd: string, ...parts: string[]): string {
  return join(cwd, '.fleet-drive', ...parts);
}

export function sessionFilePath(cwd: string): string {
  return driveFilePath(cwd, 'session.json');
}
