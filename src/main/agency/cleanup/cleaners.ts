import { existsSync } from 'node:fs';
import { readdir, rmdir } from 'node:fs/promises';
import type { ResourceKind } from '../../../shared/agency-jobs';
import type { CrewControl } from '../jobs';
import type { GitRun } from '../repo-identity';
import type { AgencyStore } from '../store/agency-store';
import type { ResourceRecord } from '../store/resource-store';
import type { CleanerResult, ResourceCleaner } from './cleanup-runner';
import { inspectWorktree, removalVerdict } from './worktree-safety';

/** Removes a worktree without force, and its branch when nothing would be lost. */
export type WorktreeRemover = {
  removeClean(worktreePath: string, branch: string | null): Promise<void>;
};

export type CleanerDeps = {
  store: AgencyStore;
  crew: CrewControl;
  git: GitRun;
  worktrees: WorktreeRemover;
};

const CLEANED: CleanerResult = { status: 'cleaned' };

/**
 * A worktree goes only when it holds nothing to lose. One that is not there
 * was never made (a crash between recording and making it) or was removed by
 * hand, and needs nothing more.
 */
function worktreeCleaner(deps: CleanerDeps, ignoreSubmodules: boolean): ResourceCleaner {
  return async (r: ResourceRecord) => {
    if (r.path === null || !existsSync(r.path)) return CLEANED;
    const verdict = removalVerdict(
      await inspectWorktree(r.path, r.branch, deps.git, { ignoreSubmodules })
    );
    if (!verdict.remove) return { status: 'kept', reason: verdict.reason };
    await deps.worktrees.removeClean(r.path, r.branch);
    return CLEANED;
  };
}

/** A job's folder goes only once it is empty. */
async function cleanFolder(r: ResourceRecord): Promise<CleanerResult> {
  if (r.path === null || !existsSync(r.path)) return CLEANED;
  const left = await readdir(r.path);
  if (left.length > 0) {
    return {
      status: 'kept',
      reason: `${left.length} ${left.length === 1 ? 'item' : 'items'} left in it`
    };
  }
  await rmdir(r.path);
  return CLEANED;
}

/** How each kind of resource is undone. */
export function defaultCleaners(deps: CleanerDeps): Record<ResourceKind, ResourceCleaner> {
  return {
    crew_pane: async (r) => {
      if (r.path !== null) await deps.crew.stop(r.path);
      for (const crew of deps.store.crew.live(r.jobId)) {
        if (crew.paneId === r.path) deps.store.crew.end(crew.id, 'job closing');
      }
      return CLEANED;
    },
    compose_project: async () =>
      Promise.reject(new Error('Fleet cannot stop Docker Compose projects yet. Stop it by hand.')),
    member_worktree: worktreeCleaner(deps, false),
    umbrella_worktree: worktreeCleaner(deps, true),
    workspace_dir: cleanFolder
  };
}
