import { existsSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgencyOnboarding, RepoResolution } from '../../../shared/agency';
import {
  remoteLabel,
  type ProjectFolder,
  type WorkspaceMember
} from '../../../shared/agency-projects';
import type { GitRun } from '../repo-identity';
import type { ProjectRegistry } from '../store/project-registry';
import { repoFacts } from './repo-reader';
import { detectWorkspace, type DetectedWorkspace } from './workspace-detect';

export type FolderProbeDeps = {
  /** Git identity of a folder, not the project it may belong to. */
  identify: (path: string) => Promise<RepoResolution>;
  git: GitRun;
  onboarding: (repoId: string) => AgencyOnboarding;
  registry: ProjectRegistry;
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const hasTeamFiles = (root: string): boolean =>
  existsSync(join(root, '.fleet', 'fleet.agency.toml')) || existsSync(join(root, '.fleet', 'crew'));

async function checkout(
  root: string,
  git: GitRun
): Promise<{ branch: string | null; remote: string | null }> {
  const [branch, facts] = await Promise.all([
    git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root),
    repoFacts(root, git)
  ]);
  return {
    branch: branch === '' ? null : branch,
    remote: facts.remote === null ? null : remoteLabel(facts.remote)
  };
}

async function workspaceRow(ws: DetectedWorkspace, deps: FolderProbeDeps): Promise<ProjectFolder> {
  const leftOut = deps.registry.byId(ws.project.repoId)?.leftOut ?? [];
  const members = await Promise.all(
    ws.members.map(async (m): Promise<WorkspaceMember> => {
      const repo =
        m.repo === null ? null : { repoId: m.repo.repoId, root: m.repo.root, name: m.repo.name };
      const facts =
        repo === null ? { branch: null, remote: null } : await checkout(repo.root, deps.git);
      return {
        name: m.name,
        path: m.path,
        repo,
        ...facts,
        umbrella: m.umbrella,
        leftOut: leftOut.includes(m.name)
      };
    })
  );
  return {
    path: ws.project.root,
    kind: 'workspace',
    project: ws.project,
    projectKind: ws.kind,
    members,
    teamFiles: hasTeamFiles(ws.project.root),
    setupDone: deps.onboarding(ws.project.repoId).setupDoneAt !== null
  };
}

/**
 * The workspace a folder opens as: one found at it, or the saved project it
 * is a member of or a folder inside of.
 */
async function workspaceOf(
  path: string,
  res: RepoResolution,
  deps: FolderProbeDeps
): Promise<DetectedWorkspace | null> {
  const found = await detectWorkspace(path, deps);
  if (found !== null) return found;
  const saved = res.ok ? deps.registry.ofRepo(res.repoId) : deps.registry.holdingFolder(path);
  return saved === null ? null : detectWorkspace(saved.root, deps);
}

/**
 * What the project picker shows for each folder it was given, in order: a
 * workspace with its members, a repository with its branch, remote and setup
 * state, or a folder that is not one. Folders that no longer exist and remote
 * ones are left out, and folders inside one project are shown once, as that
 * project.
 */
export async function probeFolders(
  paths: string[],
  deps: FolderProbeDeps
): Promise<ProjectFolder[]> {
  const unique = [...new Set(paths)].filter(isDirectory);
  const resolved = await Promise.all(
    unique.map(async (path) => {
      const real = await realpath(path).catch(() => path);
      const res = await deps.identify(real);
      return { path: real, res, ws: await workspaceOf(real, res, deps) };
    })
  );
  const seen = new Set<string>();
  const out: ProjectFolder[] = [];
  for (const { path, res, ws } of resolved) {
    if (ws !== null) {
      if (seen.has(ws.project.repoId)) continue;
      seen.add(ws.project.repoId);
      out.push(await workspaceRow(ws, deps));
      continue;
    }
    if (!res.ok) {
      if (res.reason === 'not-a-repo') out.push({ path, kind: 'not-a-repo' });
      continue;
    }
    if (seen.has(res.repoId)) continue;
    seen.add(res.repoId);
    out.push({
      path: res.root,
      kind: 'repo',
      repo: { repoId: res.repoId, root: res.root, name: res.name },
      ...(await checkout(res.root, deps.git)),
      teamFiles: hasTeamFiles(res.root),
      setupDone: deps.onboarding(res.repoId).setupDoneAt !== null
    });
  }
  return out;
}
