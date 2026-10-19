import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AGENCY_SETTINGS,
  type AgencySettings,
  type JobState
} from '../../../shared/agency';
import type { JobEvent } from '../jobs/job-machine';
import type { GhRun } from '../projects/gh';
import type { GitRun } from '../repo-identity';
import type { AgencySettingsAccess } from '../settings';
import { AgencyStore } from '../store/agency-store';

export const REPO = { repoId: '0123456789abcdef', root: '/dev/fleet', name: 'fleet' };
export const OTHER_REPO = { repoId: 'fedcba9876543210', root: '/dev/other', name: 'other' };

/** A fresh agency.db in a temp dir, on a clock the test moves by hand. */
export function storeFixture(opts: { turnLimit?: () => number } = {}): {
  store: AgencyStore;
  dbPath: string;
  clock: { now: number };
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-agency-'));
  const dbPath = join(dir, 'agency.db');
  const clock = { now: 1_000_000 };
  const store = new AgencyStore(dbPath, { now: () => clock.now, ...opts });
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

export const BASE_SHA = 'a'.repeat(40);

/** What the pre-approval check asks git, by a short name. */
export type GitFacts = {
  originHead: string | null;
  remote: string | null;
  status: string;
  headBranch: string | null;
  admiralBranch: boolean;
  sha: (ref: string) => string | null;
};

/**
 * Read-only git for the plan check, answering as a clean checkout of `main`
 * with a GitHub remote, every ref at `BASE_SHA`, unless `facts` says else.
 */
export function factsGit(facts: Partial<GitFacts> = {}): GitRun {
  const f: GitFacts = {
    originHead: 'origin/main',
    remote: 'git@github.com:acme/fleet.git',
    status: '',
    headBranch: 'main',
    admiralBranch: false,
    sha: () => BASE_SHA,
    ...facts
  };
  const answer = (args: string[]): string | null => {
    const cmd = args.join(' ');
    if (cmd.includes('refs/remotes/origin/HEAD')) return f.originHead;
    if (cmd.startsWith('remote get-url')) return f.remote;
    if (cmd.startsWith('remote')) return f.remote === null ? '' : 'origin';
    if (cmd.includes('status --porcelain')) return f.status;
    if (cmd === 'symbolic-ref --quiet --short HEAD') return f.headBranch;
    if (cmd.includes('refs/heads/admiral')) return f.admiralBranch ? '' : null;
    if (args[0] === 'rev-parse') return f.sha(args.at(-1)?.replace('^{commit}', '') ?? '');
    return null;
  };
  return async (args) => Promise.resolve(answer(args));
}

/** `gh auth status` as signed in, signed out, or not installed. */
export function fakeGh(state: 'ok' | 'signed-out' | 'not-installed' = 'ok'): GhRun {
  return async () =>
    Promise.resolve(
      state === 'not-installed' ? null : { code: state === 'ok' ? 0 : 1, stdout: '' }
    );
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

/** The events that walk a fresh `briefing` job to each state. */
const PATH_TO: Record<JobState, JobEvent[]> = {
  briefing: [],
  planned: [{ type: 'plan_proposed' }],
  running: [{ type: 'plan_proposed' }, { type: 'plan_approved' }],
  waiting: [{ type: 'plan_proposed' }, { type: 'plan_approved' }, { type: 'blocked' }],
  delivered: [{ type: 'plan_proposed' }, { type: 'plan_approved' }, { type: 'delivered' }],
  interrupted: [{ type: 'plan_proposed' }, { type: 'plan_approved' }, { type: 'interrupt' }],
  closing: [{ type: 'cancel' }],
  cancelled: [{ type: 'cancel' }, { type: 'cleanup_done', target: 'cancelled' }],
  failed: [{ type: 'fail' }, { type: 'cleanup_done', target: 'failed' }],
  closed: [
    { type: 'plan_proposed' },
    { type: 'plan_approved' },
    { type: 'delivered' },
    { type: 'accepted' },
    { type: 'cleanup_done', target: 'closed' }
  ]
};

/** Move a fresh job to `state` through allowed events, for tests that need it there. */
export function moveJob(store: AgencyStore, jobId: number, state: JobState): void {
  for (const event of PATH_TO[state]) {
    const { transition } = store.applyJobEvent(jobId, event, 'test');
    if (!transition.ok) throw new Error(transition.refused);
  }
}

/** Agency settings in memory, with `atOnce` crew of each runtime let work at once. */
export function crewAtOnce(atOnce: number): AgencySettingsAccess {
  let settings: AgencySettings = {
    ...DEFAULT_AGENCY_SETTINGS,
    crew: {
      claude: { atOnce, defaultModel: '' },
      eva: { atOnce, defaultModel: '' }
    }
  };
  return { get: () => settings, set: (next) => void (settings = next) };
}
