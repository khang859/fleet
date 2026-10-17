import { join } from 'node:path';
import type { AgencyRepoRef } from '../../../shared/agency';
import type {
  ImportDiff,
  ProjectSetup,
  RepoFile,
  SaveSetupRequest
} from '../../../shared/agency-projects';
import type { GitRun } from '../repo-identity';
import { readTextOrNull } from './files';
import { projectDir } from './paths';
import { importDestination, loadSetup, type ImportedFile } from './project-store';
import { memberOfPath, readRepoFile, scanProject, type ScanTarget } from './setup-findings';

/**
 * Crew and setup files imported from a repository's `.fleet/`. The project
 * folder's copy is what jobs use: a teammate's newer commit, a fresh clone
 * and the client's own edits all change nothing until the client takes the
 * repository's version.
 */

type ImportDeps = { home: string; git: GitRun };

/** Imported files the repository's default branch has a different version of. */
export function newerImports(saved: ProjectSetup, repoFiles: RepoFile[]): string[] {
  const shas = new Map(repoFiles.map((f) => [f.path, f.sha256]));
  return saved.imports
    .filter((i) => (shas.get(i.path) ?? i.sha256) !== i.sha256)
    .map((i) => i.path);
}

/**
 * The files a save imports. One imported before keeps the project's copy and
 * the hash it was imported at, unless the request lists it in `updates`.
 */
export async function importedFiles(
  repoId: string,
  target: ScanTarget,
  request: Pick<SaveSetupRequest, 'imports' | 'updates'>,
  deps: ImportDeps
): Promise<ImportedFile[]> {
  const updates = new Set(request.updates ?? []);
  const before = new Map(
    ((await loadSetup(repoId, deps.home))?.imports ?? []).map((i) => [i.path, i])
  );
  const out: ImportedFile[] = [];
  for (const path of request.imports) {
    const kept = updates.has(path) ? undefined : before.get(path);
    const copy = kept === undefined ? null : await projectCopy(repoId, path, deps.home);
    if (kept !== undefined && copy !== null) {
      out.push({ ...kept, content: copy });
      continue;
    }
    const file = await repoVersion(target, path, deps.git);
    if (file !== null) out.push(file);
  }
  return out;
}

/** An imported file's project copy beside the repository's version. */
export async function importDiff(
  repo: AgencyRepoRef,
  target: ScanTarget,
  path: string,
  deps: ImportDeps
): Promise<ImportDiff> {
  const saved = await loadSetup(repo.repoId, deps.home);
  if (!saved?.imports.some((i) => i.path === path)) {
    throw new Error(`${path} is not an imported file of ${repo.name}.`);
  }
  return {
    path,
    ours: (await projectCopy(repo.repoId, path, deps.home)) ?? '',
    theirs: (await repoVersion(target, path, deps.git))?.content ?? ''
  };
}

/** The project folder's copy of an imported file, or null when it is gone. */
async function projectCopy(repoId: string, path: string, home: string): Promise<string | null> {
  const dest = importDestination(path);
  return dest === null ? null : readTextOrNull(join(projectDir(repoId, home), dest));
}

/** A file setup offers to import, as the default branch of the main checkout has it. */
async function repoVersion(
  target: ScanTarget,
  path: string,
  git: GitRun
): Promise<ImportedFile | null> {
  const found = await scanProject(target, { git });
  const file = found.repoFiles.find((f) => f.path === path && f.disposition === 'importable');
  const where = memberOfPath(target.members, path);
  if (file === undefined || where === null) {
    throw new Error(`${path} is not a file setup can import.`);
  }
  const content = await readRepoFile(where.member.root, where.path, git);
  if (content === null || file.sha256 === null) return null;
  return { path, kind: file.kind, sha256: file.sha256, content };
}
