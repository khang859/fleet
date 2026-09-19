import { readFileSync } from 'fs';
import { deriveDebugPort, sessionFilePath } from '../../src/shared/drive-session';

/**
 * This checkout's dev instance, if one is up.
 *
 * Probes the per-checkout CDP port rather than trusting the session file,
 * which outlives a crashed app and does not exist yet while one is starting.
 * Kept free of playwright so the `npm run dev` guard stays fast.
 */
export async function runningDevInstance(): Promise<{ port: number; pid?: number } | null> {
  const port = deriveDebugPort(process.cwd(), process.env.FLEET_DEBUG_PORT);
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
  } catch {
    return null;
  }
  return { port, pid: sessionPid(process.cwd()) };
}

/** The app pid recorded in the session file, whether or not it is still running. */
export function sessionPid(root: string): number | undefined {
  try {
    const session: unknown = JSON.parse(readFileSync(sessionFilePath(root), 'utf8'));
    if (typeof session !== 'object' || session === null || !('pid' in session)) return undefined;
    return typeof session.pid === 'number' ? session.pid : undefined;
  } catch {
    return undefined;
  }
}
