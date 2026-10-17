import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgencyOnboarding, RepoResolution } from '../../../shared/agency';
import { remoteLabel, type ProjectFolder } from '../../../shared/agency-projects';
import type { GitRun } from '../repo-identity';
import { repoFacts } from './repo-reader';

export type FolderProbeDeps = {
  resolve: (path: string) => Promise<RepoResolution>;
  git: GitRun;
  onboarding: (repoId: string) => AgencyOnboarding;
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What the project picker shows for each folder it was given, in order: a
 * repository with its branch, remote and setup state, or a folder that is
 * not one. Folders that no longer exist and remote ones are left out, and
 * folders inside one repository are shown once, as that repository.
 */
export async function probeFolders(
  paths: string[],
  deps: FolderProbeDeps
): Promise<ProjectFolder[]> {
  const unique = [...new Set(paths)].filter(isDirectory);
  const resolved = await Promise.all(
    unique.map(async (path) => ({ path, res: await deps.resolve(path) }))
  );
  const seen = new Set<string>();
  const out: ProjectFolder[] = [];
  for (const { path, res } of resolved) {
    if (!res.ok) {
      if (res.reason === 'not-a-repo') out.push({ path, kind: 'not-a-repo' });
      continue;
    }
    if (seen.has(res.repoId)) continue;
    seen.add(res.repoId);
    const [branch, facts] = await Promise.all([
      deps.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], res.root),
      repoFacts(res.root, deps.git)
    ]);
    out.push({
      path: res.root,
      kind: 'repo',
      repo: { repoId: res.repoId, root: res.root, name: res.name },
      branch: branch === '' ? null : branch,
      remote: facts.remote === null ? null : remoteLabel(facts.remote),
      teamFiles:
        existsSync(join(res.root, '.fleet', 'fleet.agency.toml')) ||
        existsSync(join(res.root, '.fleet', 'crew')),
      setupDone: deps.onboarding(res.repoId).setupDoneAt !== null
    });
  }
  return out;
}
