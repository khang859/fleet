import { join } from 'path';

export interface DriveSession {
  port: number;
  rendererUrl: string;
  pid: number;
}

const PORT_BASE = 41000;
const PORT_SPAN = 20000;

/**
 * Choose a CDP debug port. Honors a valid FLEET_DEBUG_PORT override, otherwise
 * derives a stable per-checkout port from the app path so parallel dev
 * worktrees do not collide on a shared 9222.
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
  return PORT_BASE + (hash % PORT_SPAN);
}

export function sessionFilePath(cwd: string): string {
  return join(cwd, '.fleet-drive', 'session.json');
}
