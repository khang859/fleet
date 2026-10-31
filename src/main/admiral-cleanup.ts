import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readWindow } from './agent/session-store';
import { createLogger } from './logger';

const log = createLogger('admiral-cleanup');

/** More than any session's first line, which holds only its id, folder and date. */
const HEADER_BYTES = 8192;

const AdmiralHeader = z.object({ scope: z.literal('admiral') });

type Deps = {
  fleetHome: string;
  sessionsDir: string;
  sessions: { delete: (sessionId: string) => boolean };
  layouts: { dropJobTabs: () => void };
  settings: { dropAgency: () => void };
};

function isAdmiralSession(path: string): boolean {
  try {
    const header = readWindow(path, 0, HEADER_BYTES).split('\n')[0];
    return AdmiralHeader.safeParse(JSON.parse(header)).success;
  } catch {
    return false;
  }
}

function deleteAdmiralSessions({ sessionsDir, sessions }: Deps): void {
  if (!existsSync(sessionsDir)) return;
  const files = readdirSync(sessionsDir).filter((name) => name.endsWith('.jsonl'));
  for (const name of files) {
    if (isAdmiralSession(join(sessionsDir, name))) sessions.delete(name.slice(0, -'.jsonl'.length));
  }
}

/**
 * Remove what the Admiral left behind, once. `agency.db` goes last, so a start
 * that fails part way tries again the next time.
 *
 * Everything a window reads is gone before the first `await`, and the folders
 * follow in the background: a job's worktrees can take a while to delete.
 */
export async function removeAdmiralData(deps: Deps): Promise<void> {
  const db = join(deps.fleetHome, 'agency.db');
  if (!existsSync(db)) return;

  log.info('removing Admiral data');
  deps.layouts.dropJobTabs();
  deps.settings.dropAgency();
  deleteAdmiralSessions(deps);

  const leftovers = ['agency', 'crew', 'agency.db-wal', 'agency.db-shm'];
  for (const name of leftovers) {
    await rm(join(deps.fleetHome, name), { recursive: true, force: true });
  }
  await rm(db, { force: true });
}
