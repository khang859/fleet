import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { jobDisplayId, type ResourceKind } from '../../../shared/agency';
import type { PlanBases } from '../../../shared/agency-jobs';
import { workspaceSources, type PlanStep } from '../../../shared/agency-plan';
import type { ProjectKind, ProjectSetup } from '../../../shared/agency-projects';
import { gitExec } from '../exec';
import { changedMembers } from '../plans/plan-checks';
import { projectMembers, type ProjectMember } from '../projects/workspace-projects';
import type { AgencyStore } from '../store/agency-store';
import type { ResourceMode } from '../store/resource-store';
import { jobDir } from '../projects/paths';
import { loadSetup } from '../projects/project-store';
import { composeProjectName, portEnv, PortBlocks } from './port-blocks';
import { runSetup, type SetupRun } from './setup-run';

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

export type JobWorkspace = {
  id: number;
  root: string;
  /** Where the crew pane starts: the root, or the one member a step of several repositories works in. */
  cwd: string;
  branch: string;
  parts: WorkspacePart[];
  /** Its port variables, `FLEET_PORTS` and `COMPOSE_PROJECT_NAME`, for its panes. */
  env: Record<string, string>;
};

/** The folder a step's crew member works in, the workspace it belongs to, and that workspace's env. */
export type StepFolder = { id: number; root: string; cwd: string; env: Record<string, string> };

/** `git <args>` in `cwd`: stdout, or null when git failed. */
export type GitWrite = (args: string[], cwd: string) => Promise<string | null>;

/** A crew branch: the same name in every member the step changes, never reused in a job. */
export const crewBranch = (jobId: number, stepId: string, n: number): string =>
  `admiral/${jobDisplayId(jobId)}/${stepId}-${n}`;

/**
 * The folder whose Claude Code trust covers a project's crew folders. Claude
 * Code keys the trust of a worktree on its main checkout, so a repository or
 * an umbrella is trusted at its root. A folder project's job workspaces are
 * plain folders in the jobs folder, which trusting the jobs folder covers.
 */
export function claudeTrustFolder(kind: ProjectKind, root: string, home: string): string {
  return kind === 'folder' ? join(home, 'jobs') : root;
}

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

/** The one member worktree a step works in, when there is one and the project has several. */
function crewFolder(
  kind: ProjectKind,
  root: string,
  parts: Array<{ kind: ResourceKind; path: string | null }>
): string {
  const members = parts.filter((p) => p.kind === 'member_worktree');
  return kind !== 'repo' && members.length === 1 ? (members[0].path ?? root) : root;
}

/** The port variables of the members a workspace holds, in member order, each once. */
function workspacePortVars(setup: ProjectSetup | null, parts: WorkspacePart[]): string[] {
  const held = new Set(parts.map((p) => p.member));
  const vars = (setup?.members ?? []).filter((m) => held.has(m.name)).flatMap((m) => m.portVars);
  return [...new Set(vars)];
}

/**
 * Makes job workspaces under `<agency home>/jobs/<id>/ws/<step>-<n>/`. Each
 * part is recorded before it is made, so a crash or a failed `git worktree
 * add` leaves a row the job's cleanup undoes, member by member.
 */
export class JobWorkspaces {
  private readonly git: GitWrite;

  private readonly runSetup: (run: SetupRun) => Promise<string | null>;

  private readonly ports: PortBlocks;

  constructor(
    private readonly deps: {
      store: AgencyStore;
      home: () => string;
      git?: GitWrite;
      runSetup?: (run: SetupRun) => Promise<string | null>;
      portFree?: (port: number) => Promise<boolean>;
    }
  ) {
    this.git = deps.git ?? gitExec;
    this.runSetup = deps.runSetup ?? runSetup;
    this.ports = new PortBlocks(() => deps.store.resources.heldPorts(), deps.portFree);
  }

  /**
   * The folder a step's crew member works in: the worktree of the step it
   * reads for an `{of}` step, so each worktree has one writer, else a new one.
   */
  async open(jobId: number, stepId: string): Promise<StepFolder> {
    const step = this.deps.store.plans.approved(jobId)?.plan.steps.find((s) => s.id === stepId);
    if (step === undefined || step.workspace === 'new' || !('of' in step.workspace)) {
      const { id, root, cwd, env } = await this.make(jobId, stepId);
      return { id, root, cwd, env };
    }
    const source = step.workspace.of;
    const id = this.stepWorkspace(jobId, source);
    const folder = id === null ? null : this.folder(jobId, id);
    if (folder === null) throw new Error(`${source} has no worktree to read yet.`);
    return folder;
  }

  /** A workspace made before, as the folder its crew work in; null once it is gone. */
  folder(jobId: number, id: number): StepFolder | null {
    const { store } = this.deps;
    const root = store.resources.workspaceRoot(id);
    if (root === null) return null;
    const repo = store.jobRepo(jobId)?.repo;
    const kind = repo === undefined ? 'repo' : projectMembers(store.projects, repo).kind;
    return {
      id,
      root,
      cwd: crewFolder(kind, root, store.resources.ofWorkspace(id)),
      env: store.resources.workspaceEnv(id)
    };
  }

  /** The workspace a step's last crew member worked in, or null when it had none. */
  private stepWorkspace(jobId: number, stepId: string): number | null {
    const crew = this.deps.store.crew.all(jobId).filter((c) => c.stepId === stepId);
    return crew.findLast((c) => c.workspaceId !== null)?.workspaceId ?? null;
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
    const setup = await loadSetup(repo.repoId, this.deps.home());
    const vars = workspacePortVars(setup, parts);
    const { id, rows, env } = await this.ports.pick(vars, (ports) => {
      const env = portEnv(ports, vars, composeProjectName(jobId, stepId, n));
      const ws = { jobId, stepId, attempt: n, root, branch, ports, env };
      return { env, ...store.tx(() => this.recordParts(ws, parts)) };
    });
    for (const [i, p] of parts.entries()) {
      await this.makePart(p);
      store.resources.made(rows[i].id);
    }
    await this.mergeSources(jobId, step, parts);
    const logs = join(jobDir(this.deps.home(), jobId), 'setup', `${stepId}-${n}`);
    await this.setUp(setup, { kind, members, parts, root, logs, env });
    return { id, root, cwd: crewFolder(kind, root, parts), branch, parts, env };
  }

  /** The workspace and a row for each part, before any of them is made. */
  private recordParts(
    ws: Parameters<AgencyStore['resources']['addWorkspace']>[0],
    parts: WorkspacePart[]
  ): { id: number; rows: Array<{ id: number }> } {
    const { resources } = this.deps.store;
    const id = resources.addWorkspace(ws);
    const rows = parts.map((p) =>
      resources.record({
        jobId: ws.jobId,
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
  }

  /**
   * Merge the branches of the steps whose output the step works in: its
   * `after` steps for `new`, those it names for `{integrate}`. Only what they
   * committed comes along. A step with no crew member has no branch.
   */
  private async mergeSources(jobId: number, step: PlanStep, parts: WorkspacePart[]): Promise<void> {
    const sources = step.workspace === 'new' ? step.after : workspaceSources(step.workspace);
    for (const source of sources) {
      const id = this.stepWorkspace(jobId, source);
      if (id === null) continue;
      const branches = this.branches(id);
      for (const p of parts) {
        const branch = p.member === null ? undefined : branches.get(p.member);
        if (branch !== undefined && p.kind !== 'workspace_dir') await this.merge(source, branch, p);
      }
    }
  }

  /** Each member's branch in a workspace. */
  private branches(workspaceId: number): Map<string, string> {
    return new Map(
      this.deps.store.resources
        .ofWorkspace(workspaceId)
        .flatMap((r) => (r.member !== null && r.branch !== null ? [[r.member, r.branch]] : []))
    );
  }

  /** Merge `source`'s branch into one member's worktree, or abort and say which files conflict. */
  private async merge(source: string, branch: string, p: WorkspacePart): Promise<void> {
    if ((await this.git(['merge', '--no-edit', '--quiet', branch], p.path)) !== null) return;
    const conflicts = (await this.git(['diff', '--name-only', '--diff-filter=U'], p.path)) ?? '';
    await this.git(['merge', '--abort'], p.path);
    const files = conflicts.trim().split('\n').filter(Boolean);
    throw new Error(
      files.length > 0
        ? `${source}'s branch ${branch} conflicts in ${p.member}: ${files.join(', ')}. Give the steps different scopes, or merge them in an integrate step.`
        : `git could not merge ${source}'s branch ${branch} into ${p.member}.`
    );
  }

  /**
   * Run each member's setup in its worktree in member order, then the
   * workspace setup at the root. The first one that fails stops the rest.
   */
  private async setUp(
    setup: ProjectSetup | null,
    ws: {
      kind: ProjectKind;
      members: ProjectMember[];
      parts: WorkspacePart[];
      root: string;
      logs: string;
      env: Record<string, string>;
    }
  ): Promise<void> {
    if (setup === null) return;
    const runs: SetupRun[] = [];
    for (const member of ws.members) {
      const part = ws.parts.find((p) => p.member === member.name);
      const saved = setup.members.find((m) => m.name === member.name);
      if (part === undefined || saved === undefined || saved.setupCommand.trim() === '') continue;
      runs.push({
        label: `${member.name} setup`,
        command: saved.setupCommand,
        cwd: part.path,
        timeoutSec: saved.setupTimeoutSec,
        log: join(ws.logs, `${member.name}.log`),
        env: ws.env
      });
    }
    if (ws.kind !== 'repo' && setup.setupCommand.trim() !== '') {
      runs.push({
        label: 'Workspace setup',
        command: setup.setupCommand,
        cwd: ws.root,
        timeoutSec: setup.setupTimeoutSec,
        log: join(ws.logs, 'workspace.log'),
        env: ws.env
      });
    }
    for (const run of runs) {
      const failed = await this.runSetup(run);
      if (failed !== null) throw new Error(failed);
    }
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
