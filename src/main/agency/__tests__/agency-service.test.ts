import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgencyChanged } from '../../../shared/agency';
import { AgencyService } from '../index';
import { AgencyStore } from '../store/agency-store';
import { REPO, YES_NO, moveJob } from './fixture';

let dir: string;
let dbPath: string;
let emitted: AgencyChanged[];
let service: AgencyService;
const clock = { now: 1_000_000 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-svc-'));
  dbPath = join(dir, 'agency.db');
  emitted = [];
  service = new AgencyService({
    dbPath,
    emit: (change) => emitted.push(change),
    hasModelKey: () => true,
    now: () => clock.now
  });
});
afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('AgencyService', () => {
  it('releases every wakeup claim left from the last run when it starts', () => {
    service.ensureLobby(REPO);
    service.store.enqueueWakeup({
      repoId: REPO.repoId,
      jobId: null,
      kind: 'event',
      payload: { line: 'x' }
    });
    const claimed = service.pullWakeups({ repoId: REPO.repoId, jobId: null }).ids;
    service.close();

    service = new AgencyService({
      dbPath,
      emit: () => {},
      hasModelKey: () => true,
      now: () => clock.now
    });
    expect(service.pullWakeups({ repoId: REPO.repoId, jobId: null }).ids).toEqual(claimed);
  });

  it('raises one change event per repository for the jobs a write touched', async () => {
    const job = service.store.openJob({
      repoId: REPO.repoId,
      title: 't',
      brief: 'b',
      sessionId: 's-1'
    });
    moveJob(service.store, job.id, 'running');
    const q = service.store.askQuestion({
      repoId: REPO.repoId,
      jobId: job.id,
      question: 'Q?',
      options: YES_NO
    });

    expect(service.answer({ id: q.id, option: 0 })?.status).toBe('answered');
    expect(service.answer({ id: q.id, option: 0 })).toBeNull();
    expect(service.cancelJobs(REPO.repoId)).toEqual([job.id]);
    await service.cleanup.start(job.id);
    expect(service.markHandoff({ jobId: job.id, lobbyMessageId: 'm' })).toBe(true);
    expect(service.markHandoff({ jobId: 999, lobbyMessageId: 'm' })).toBe(false);
    // Answer, cancel, the cleanup that ends the job, and the handoff.
    expect(emitted).toEqual([
      { repoId: REPO.repoId, jobIds: [job.id] },
      { repoId: REPO.repoId, jobIds: [job.id] },
      { repoId: REPO.repoId, jobIds: [job.id] },
      { repoId: REPO.repoId, jobIds: [job.id] }
    ]);
  });

  it('keeps the one-per-repo claim in main, tied to the window that made it', () => {
    expect(service.claim({ repoId: REPO.repoId, paneId: 'p1' }, 1)).toEqual({ ok: true });
    expect(service.claim({ repoId: REPO.repoId, paneId: 'p2' }, 2)).toEqual({
      ok: false,
      ownerPaneId: 'p1'
    });
    service.releaseOwner(1);
    expect(service.claim({ repoId: REPO.repoId, paneId: 'p2' }, 2)).toEqual({ ok: true });
  });

  it('hands back the wakeups a window pulled when it reloads, without a failure', () => {
    service.ensureLobby(REPO);
    const other = { ...REPO, repoId: 'fedcba9876543210', name: 'other' };
    service.ensureLobby(other);
    for (const repo of [REPO, other]) {
      service.store.enqueueWakeup({
        repoId: repo.repoId,
        jobId: null,
        kind: 'event',
        payload: { line: 'x' }
      });
    }
    service.claim({ repoId: REPO.repoId, paneId: 'p1' }, 1);
    service.claim({ repoId: other.repoId, paneId: 'p2' }, 2);
    const mine = service.pullWakeups({ repoId: REPO.repoId, jobId: null }).ids;
    expect(service.pullWakeups({ repoId: other.repoId, jobId: null }).ids).toHaveLength(1);

    service.releaseOwner(1);

    expect(service.pullWakeups({ repoId: REPO.repoId, jobId: null }).ids).toEqual(mine);
    // The other window's claim is still its own.
    expect(service.pullWakeups({ repoId: other.repoId, jobId: null }).ids).toEqual([]);
    expect(service.snapshot(REPO.repoId).questions).toEqual([]);
  });

  it('hands back a closed pane’s wakeups the same way', () => {
    service.ensureLobby(REPO);
    service.store.enqueueWakeup({
      repoId: REPO.repoId,
      jobId: null,
      kind: 'event',
      payload: { line: 'x' }
    });
    service.claim({ repoId: REPO.repoId, paneId: 'p1' }, 1);
    const pulled = service.pullWakeups({ repoId: REPO.repoId, jobId: null }).ids;

    service.release('p1');

    expect(service.pullWakeups({ repoId: REPO.repoId, jobId: null }).ids).toEqual(pulled);
  });

  it('stores into the file it was given', () => {
    service.ensureLobby(REPO);
    service.close();
    const store = new AgencyStore(dbPath);
    expect(store.lobbySessionId(REPO.repoId)).not.toBeNull();
    store.close();
    service = new AgencyService({ dbPath, emit: () => {}, hasModelKey: () => false });
  });
});
