import { join } from 'node:path';
import type { AgencyRepoRef } from '../../../shared/agency';
import type { ProjectKind, ProjectSetup } from '../../../shared/agency-projects';
import type { ProjectRegistry, RegisteredProject } from '../store/project-registry';
import type { ScanTarget } from './setup-findings';
import type { DetectedWorkspace } from './workspace-detect';

/**
 * The members the client left out in the picker, checked: each must be a
 * member, the umbrella cannot be one, and at least one checked-out member
 * stays. Returns them without repeats.
 */
export function checkedLeftOut(ws: DetectedWorkspace, leftOut: string[]): string[] {
  const names = new Set(ws.members.map((m) => m.name));
  const unique = [...new Set(leftOut)];
  const unknown = unique.find((n) => !names.has(n));
  if (unknown !== undefined) throw new Error(`${unknown} is not a member of ${ws.project.name}.`);
  if (ws.members.some((m) => m.umbrella && unique.includes(m.name))) {
    throw new Error('The umbrella repository is the project, so it cannot be left out.');
  }
  if (ws.members.every((m) => unique.includes(m.name) || m.repo === null)) {
    throw new Error('Keep at least one checked-out member in the project.');
  }
  return unique;
}

/**
 * A workspace as the registry keeps it: its checked-out members the client
 * kept, in member order, with the remote and default branch their saved
 * setup gives.
 */
export function registeredProject(
  ws: DetectedWorkspace,
  leftOut: string[],
  setup: ProjectSetup | null
): RegisteredProject {
  const members = ws.members.flatMap((m) => {
    if (m.repo === null || leftOut.includes(m.name)) return [];
    const saved = setup?.members.find((s) => s.name === m.name);
    return [
      {
        name: m.name,
        path: m.path,
        repoId: m.repo.repoId,
        gitCommonDir: m.repo.gitCommonDir,
        remote: saved?.remote ?? null,
        defaultBranch: saved?.defaultBranch ?? null
      }
    ];
  });
  return {
    id: ws.project.repoId,
    root: ws.project.root,
    kind: ws.kind,
    name: ws.project.name,
    leftOut,
    members
  };
}

/**
 * What setup reads in a workspace: the members the client kept, and the kept
 * submodules that are not checked out as missing.
 */
export function workspaceTarget(
  repo: AgencyRepoRef,
  ws: DetectedWorkspace,
  leftOut: string[]
): ScanTarget {
  const kept = ws.members.filter((m) => !leftOut.includes(m.name));
  return {
    repo,
    kind: ws.kind,
    members: kept.flatMap((m) =>
      m.repo === null ? [] : [{ name: m.name, path: m.path, root: m.repo.root }]
    ),
    missing: kept.filter((m) => m.repo === null).map((m) => ({ name: m.name, path: m.path }))
  };
}

/** A member as jobs use it: its name, its path in the project, and its main checkout. */
export type ProjectMember = { name: string; path: string; root: string };

/** The member a result or step names; the first member when it names none, as in a one-repository project. */
export function memberOf<M extends ProjectMember>(members: M[], name: string | null): M {
  return members.find((m) => m.name === name) ?? members[0];
}

/**
 * A project's members in member order, each with the folder of its main
 * checkout. A one-repository project is its one member at `.`.
 */
export function projectMembers(
  registry: ProjectRegistry,
  repo: AgencyRepoRef
): { kind: ProjectKind; members: ProjectMember[] } {
  const project = registry.byId(repo.repoId);
  if (project === null) {
    return { kind: 'repo', members: [{ name: repo.name, path: '.', root: repo.root }] };
  }
  return {
    kind: project.kind,
    members: project.members.map((m) => ({
      name: m.name,
      path: m.path,
      root: join(project.root, m.path)
    }))
  };
}
