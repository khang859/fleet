import { existsSync } from 'node:fs';
import { mkdir, readdir, rmdir } from 'node:fs/promises';
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
async function removeWorktree(
  deps: CleanerDeps,
  r: ResourceRecord,
  ignoreSubmodules: boolean
): Promise<CleanerResult> {
  if (r.path === null || !existsSync(r.path)) return CLEANED;
  const verdict = removalVerdict(
    await inspectWorktree(r.path, r.branch, deps.git, { ignoreSubmodules })
  );
  if (!verdict.remove) return { status: 'kept', reason: verdict.reason };
  await deps.worktrees.removeClean(r.path, r.branch);
  return CLEANED;
}

/** The other resources of the job workspace a resource belongs to. */
const workspaceMates = (deps: CleanerDeps, r: ResourceRecord): ResourceRecord[] =>
  r.workspaceId === null
    ? []
    : deps.store.resources.ofWorkspace(r.workspaceId).filter((o) => o.id !== r.id);

/**
 * A member worktree in an umbrella worktree leaves its submodule folder
 * behind, empty, as git leaves a submodule that is not checked out; without
 * it the umbrella would show the submodule as deleted and keep itself.
 */
function memberCleaner(deps: CleanerDeps): ResourceCleaner {
  return async (r) => {
    const result = await removeWorktree(deps, r, false);
    const inUmbrella = workspaceMates(deps, r).some((o) => o.kind === 'umbrella_worktree');
    if (result.status === 'cleaned' && inUmbrella && r.path !== null) {
      await mkdir(r.path, { recursive: true });
    }
    return result;
  };
}

/** An umbrella worktree goes last, and stays while a member worktree in it stays. */
function umbrellaCleaner(deps: CleanerDeps): ResourceCleaner {
  return async (r) => {
    const held = workspaceMates(deps, r).filter(
      (o) => o.kind === 'member_worktree' && o.status !== 'cleaned' && o.status !== 'dismissed'
    );
    if (held.length > 0) {
      const names = held.map((o) => o.member ?? o.label).join(', ');
      return { status: 'kept', reason: `the ${names} worktree in it is still there` };
    }
    return removeWorktree(deps, r, true);
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
    member_worktree: memberCleaner(deps),
    umbrella_worktree: umbrellaCleaner(deps),
    workspace_dir: cleanFolder
  };
}
