import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgencyStore } from '../store/agency-store';

export const REPO = { repoId: '0123456789abcdef', root: '/dev/fleet', name: 'fleet' };
export const OTHER_REPO = { repoId: 'fedcba9876543210', root: '/dev/other', name: 'other' };

/** A fresh agency.db in a temp dir, on a clock the test moves by hand. */
export function storeFixture(): {
  store: AgencyStore;
  dbPath: string;
  clock: { now: number };
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-agency-'));
  const dbPath = join(dir, 'agency.db');
  const clock = { now: 1_000_000 };
  const store = new AgencyStore(dbPath, { now: () => clock.now });
  return {
    store,
    dbPath,
    clock,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

let sessions = 0;

/** Open a job with a session id of its own. */
export function openJob(
  store: AgencyStore,
  repoId = REPO.repoId,
  title = 'Fix the login bug'
): ReturnType<AgencyStore['openJob']> {
  sessions += 1;
  return store.openJob({ repoId, title, brief: `${title}, please`, sessionId: `job-${sessions}` });
}

export const YES_NO = [{ label: 'Yes' }, { label: 'No', detail: 'leave it as it is' }];
