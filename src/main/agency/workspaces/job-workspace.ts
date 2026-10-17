import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { jobDisplayId, type ResourceKind } from '../../../shared/agency';
import type { PlanBases } from '../../../shared/agency-jobs';
import type { PlanStep } from '../../../shared/agency-plan';
import type { ProjectKind } from '../../../shared/agency-projects';
import { gitExec } from '../exec';
import { changedMembers } from '../plans/plan-checks';
import { projectMembers, type ProjectMember } from '../projects/workspace-projects';
import type { AgencyStore } from '../store/agency-store';
import type { ResourceMode } from '../store/resource-store';
import { jobDir } from '../projects/paths';

/** One thing a job workspace is made of, in the order it is made. */
export type WorkspacePart = {
  kind: Extract<ResourceKind, 'workspace_dir' | 'umbrella_worktree' | 'member_worktree'>;
  member: string | null;
  path: string;
  /** The member's main checkout, which the worktree is added from. */
  from: string | null;
  /** The step's branch in a member it changes; null in one it only reads. */
  branch: string | null;
  baseSha: string | null;
  mode: ResourceMode;
};

export type JobWorkspace = { id: number; root: string; branch: string; parts: WorkspacePart[] };

/** `git <args>` in `cwd`: stdout, or null when git failed. */
export type GitWrite = (args: string[], cwd: string) => Promise<string | null>;

/** A crew branch: the same name in every member the step changes, never reused in a job. */
export const crewBranch = (jobId: number, stepId: string, n: number): string =>
  `admiral/${jobDisplayId(jobId)}/${stepId}-${n}`;

/**
 * What a step's job workspace holds, laid out like the project so relative
 * paths work. A one-repository project is one worktree. A submodules project
 * is a worktree of the umbrella with a worktree of each member the step needs
 * in its submodule path; a folder project is a plain folder of them. Members
 * the step changes get its branch at their pinned base; members it only reads
 * are detached at theirs, so there is nothing of theirs to push.
 */
export function workspaceLayout(input: {
  kind: ProjectKind;
  members: ProjectMember[];
  step: PlanStep;
  bases: PlanBases;
  root: string;
  branch: string;
}): WorkspacePart[] {
  const names = input.members.map((m) => m.name);
  const changed = new Set(changedMembers(input.step, names));
  const needed = new Set([...changed, ...input.step.reads]);
  const stranger = [...needed].find((n) => !names.includes(n));
  if (stranger !== undefined) {
    throw new Error(`${input.step.id} names ${stranger}, which is not in this project.`);
  }
  const part = (m: ProjectMember, kind: WorkspacePart['kind'], path: string): WorkspacePart => {
    const base = input.bases[m.name] as PlanBases[string] | undefined;
    if (base === undefined) throw new Error(`${m.name} has no base commit pinned.`);
    const writes = changed.has(m.name);
    return {
      kind,
      member: m.name,
      path,
      from: m.root,
      branch: writes ? input.branch : null,
      baseSha: base.sha,
      mode: writes ? 'writable' : 'read'
    };
  };
  if (input.kind === 'repo') return [part(input.members[0], 'member_worktree', input.root)];
  const members = input.members
    .filter((m) => m.path !== '.' && needed.has(m.name))
    .map((m) => part(m, 'member_worktree', join(input.root, m.path)));
  if (input.kind === 'folder') {
    const folder: WorkspacePart = {
      kind: 'workspace_dir',
      member: null,
      path: input.root,
      from: null,
      branch: null,
      baseSha: null,
      mode: 'writable'
    };
    return [folder, ...members];
  }
  const umbrella = input.members.find((m) => m.path === '.');
  if (umbrella === undefined) throw new Error('The umbrella repository is not in this project.');
  return [part(umbrella, 'umbrella_worktree', input.root), ...members];
}

const partLabel = (p: WorkspacePart): string =>
  p.member === null ? 'Job workspace folder' : `${p.member} worktree`;

/**
 * Makes job workspaces under `<agency home>/jobs/<id>/ws/<step>-<n>/`. Each
 * part is recorded before it is made, so a crash or a failed `git worktree
 * add` leaves a row the job's cleanup undoes, member by member.
 */
export class JobWorkspaces {
  private readonly git: GitWrite;

  constructor(private readonly deps: { store: AgencyStore; home: () => string; git?: GitWrite }) {
    this.git = deps.git ?? gitExec;
  }

  /** A new job workspace for a step of the job's approved plan, at its pinned bases. */
  async make(jobId: number, stepId: string): Promise<JobWorkspace> {
    const { store } = this.deps;
    const repo = store.jobRepo(jobId)?.repo;
    const approved = store.plans.approved(jobId);
    const step = approved?.plan.steps.find((s) => s.id === stepId);
    if (repo === undefined || approved?.bases == null || step === undefined) {
      throw new Error(`${stepId} is not a step of an approved plan of ${jobDisplayId(jobId)}.`);
    }
    const { kind, members } = projectMembers(store.projects, repo);
    const n = store.plans.nextBranchSeq(jobId, stepId);
    const branch = crewBranch(jobId, stepId, n);
    const root = join(jobDir(this.deps.home(), jobId), 'ws', `${stepId}-${n}`);
    const parts = workspaceLayout({ kind, members, step, bases: approved.bases, root, branch });
    await this.checkFree(root, parts);
    const { id, rows } = store.tx(() => {
      const id = store.resources.addWorkspace({ jobId, stepId, attempt: n, root, branch });
      const rows = parts.map((p) =>
        store.resources.record({
          jobId,
          workspaceId: id,
          kind: p.kind,
          label: partLabel(p),
          member: p.member,
          path: p.path,
          branch: p.branch,
          baseSha: p.baseSha,
          mode: p.mode
        })
      );
      return { id, rows };
    });
    for (const [i, p] of parts.entries()) {
      await this.makePart(p);
      store.resources.made(rows[i].id);
    }
    return { id, root, branch, parts };
  }

  /** Nothing is made when the folder is taken or a member already has the branch. */
  private async checkFree(root: string, parts: WorkspacePart[]): Promise<void> {
    if (existsSync(root)) throw new Error(`${root} already exists.`);
    for (const p of parts) {
      if (p.branch === null || p.from === null) continue;
      const taken = await this.git(
        ['show-ref', '--verify', '--quiet', `refs/heads/${p.branch}`],
        p.from
      );
      if (taken !== null) throw new Error(`${p.member} already has a branch ${p.branch}.`);
    }
  }

  private async makePart(p: WorkspacePart): Promise<void> {
    if (p.kind === 'workspace_dir' || p.from === null || p.baseSha === null) {
      await mkdir(p.path, { recursive: true });
      return;
    }
    await mkdir(dirname(p.path), { recursive: true });
    const on = p.branch === null ? ['--detach'] : ['-b', p.branch];
    const out = await this.git(['worktree', 'add', '--quiet', ...on, p.path, p.baseSha], p.from);
    if (out === null) throw new Error(`Could not add a worktree of ${p.member} at ${p.path}.`);
  }
}
