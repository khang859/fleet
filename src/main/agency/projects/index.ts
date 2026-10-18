import {
  RUNNING_JOB_STATES,
  type AgencyChanged,
  type AgencyRepoRef,
  type RepoResolution
} from '../../../shared/agency';
import { YOU_LAYER, YOU_SOURCE } from '../../../shared/agency-client-file';
import {
  meetAnswerResult,
  meetQuestion,
  type MeetAnswer,
  type MeetQuestionId
} from '../../../shared/agency-meet';
import type {
  AgencyProjectSummary,
  BriefIdeas,
  ClientFileView,
  ProjectTrust,
  ClientLineInput,
  ClientLineResult,
  ImportDiff,
  ProjectFolder,
  RuleCandidates,
  SaveSetupRequest,
  SetupScan
} from '../../../shared/agency-projects';
import { join } from 'node:path';
import type { GitRun } from '../repo-identity';
import type { AgencyStore } from '../store/agency-store';
import { briefIdeas } from './brief-ideas';
import { ruleCandidates, type ClientFiles } from './client-file';
import { probeFolders } from './folders';
import { nativeGh, type GhRun } from './gh';
import { importDiff, importedFiles, newerImports } from './imports';
import { agencyHome } from './paths';
import { loadSetup, saveSetup, shareWithTeam } from './project-store';
import { readOnlyGit } from './repo-reader';
import { repoTarget, scanProject, type ScanTarget } from './setup-findings';
import { detectWorkspace, type DetectedWorkspace } from './workspace-detect';
import {
  checkedLeftOut,
  memberChangeRefusal,
  registeredProject,
  workspaceTarget
} from './workspace-projects';
import { checkOutSubmodule } from '../workspaces/submodules';

export type ProjectsDeps = {
  store: AgencyStore;
  clientFiles: ClientFiles;
  /** The project a folder belongs to. */
  resolve: (path: string) => Promise<RepoResolution>;
  /** The git repository a folder is in, whatever project holds it. */
  identify: (path: string) => Promise<RepoResolution>;
  emit: (change: AgencyChanged) => void;
  gh?: GhRun;
  git?: GitRun;
  /** Checks out one submodule of an umbrella; defaults to git. */
  checkOut?: (umbrellaRoot: string, path: string) => Promise<void>;
  /** Defaults to `~/.fleet/agency` (or `FLEET_AGENCY_HOME`). */
  home?: string;
};

export type SaveSetupInput = SaveSetupRequest;

/**
 * Onboarding's main-process side: the first-run flag, the picker's folders,
 * setup's scan and save, the client file and the brief ideas. Every write
 * that moves a repository through onboarding raises a change for it, so its
 * Admiral pane moves on to the next screen.
 */
export class ProjectsService {
  private readonly gh: GhRun;
  private readonly git: GitRun;
  private readonly checkOut: (umbrellaRoot: string, path: string) => Promise<void>;

  constructor(private readonly deps: ProjectsDeps) {
    this.gh = deps.gh ?? nativeGh;
    this.git = deps.git ?? readOnlyGit;
    this.checkOut = deps.checkOut ?? checkOutSubmodule;
  }

  private get home(): string {
    return this.deps.home ?? agencyHome();
  }

  firstRunDone(): boolean {
    return this.deps.store.firstRunDone();
  }

  finishFirstRun(): void {
    this.deps.store.finishFirstRun();
  }

  async probeFolders(paths: string[]): Promise<ProjectFolder[]> {
    return probeFolders(paths, {
      identify: this.deps.identify,
      git: this.git,
      onboarding: (repoId) => this.deps.store.onboarding(repoId),
      registry: this.deps.store.projects
    });
  }

  /**
   * Make the workspace at `path` a project, with the members the client left
   * out in the picker, so every member finds its Admiral. Returns the project
   * to open. The umbrella cannot be left out, and at least one member stays.
   */
  async chooseWorkspace(input: { path: string; leftOut: string[] }): Promise<AgencyRepoRef> {
    const ws = await this.detect(input.path);
    if (ws === null) throw new Error(`${input.path} is not a workspace of repositories.`);
    this.deps.store.projects.save(registeredProject(ws, checkedLeftOut(ws, input.leftOut), null));
    return ws.project;
  }

  private async detect(path: string): Promise<DetectedWorkspace | null> {
    return detectWorkspace(path, { identify: this.deps.identify });
  }

  /**
   * What setup reads for a project: the workspace found at its root less the
   * members left out, or the one repository.
   */
  private async target(
    repo: AgencyRepoRef
  ): Promise<{ target: ScanTarget; workspace: DetectedWorkspace | null; leftOut: string[] }> {
    const ws = await this.detect(repo.root);
    if (ws?.project.repoId !== repo.repoId) {
      return { target: repoTarget(repo), workspace: null, leftOut: [] };
    }
    const leftOut = this.deps.store.projects.byId(repo.repoId)?.leftOut ?? [];
    return { target: workspaceTarget(repo, ws, leftOut), workspace: ws, leftOut };
  }

  listProjects(): AgencyProjectSummary[] {
    return this.deps.store.listProjects();
  }

  /**
   * The repository a renderer names, checked against git: its root must still
   * resolve to that id. Setup writes into the repository on "Share with
   * team", so a stale or made-up path must not become a place to write.
   */
  private async verified(repo: AgencyRepoRef): Promise<AgencyRepoRef> {
    const res = await this.deps.resolve(repo.root);
    if (!res.ok || res.repoId !== repo.repoId || res.root !== repo.root) {
      throw new Error(`${repo.root} is no longer the repository ${repo.name}.`);
    }
    return { repoId: res.repoId, root: res.root, name: res.name };
  }

  /**
   * Setup's findings for a project, member by member. A saved setup wins for
   * the members it has; a member checked out since gets fresh findings. The
   * remote is the repository's, not the client's, so it is always read fresh.
   */
  async scan(repo: AgencyRepoRef): Promise<SetupScan> {
    const checked = await this.verified(repo);
    const { target } = await this.target(checked);
    const [found, saved] = await Promise.all([
      scanProject(target, { git: this.git, gh: this.gh }),
      loadSetup(checked.repoId, this.home)
    ]);
    if (saved === null) return { ...found, saved: false, newer: [] };
    const members = found.setup.members.map((fresh) => {
      const own = saved.members.find((m) => m.name === fresh.name);
      return own === undefined ? fresh : { ...own, remote: fresh.remote };
    });
    return {
      ...found,
      setup: { ...saved, kind: found.kind, members },
      saved: true,
      newer: newerImports(saved, found.repoFiles)
    };
  }

  /** An imported file's project copy beside the repository's version, for the diff. */
  async importDiff(input: { repo: AgencyRepoRef; path: string }): Promise<ImportDiff> {
    const repo = await this.verified(input.repo);
    const { target } = await this.target(repo);
    return importDiff(repo, target, input.path, { home: this.home, git: this.git });
  }

  /**
   * Save a project's setup; `finish` also marks setup done, which moves the
   * pane on. The members must be the project's own, at their own paths, so a
   * renderer cannot name a folder that is not one of them. Setup that adds or
   * drops a member waits until no job is running, since jobs work in the
   * members the project has now.
   */
  async saveSetup(input: SaveSetupInput, opts: { finish: boolean }): Promise<string> {
    const repo = await this.verified(input.repo);
    const { target, workspace, leftOut } = await this.target(repo);
    if (input.setup.kind !== target.kind) {
      throw new Error(`${repo.name} is a ${target.kind} project now. Scan it again.`);
    }
    for (const m of input.setup.members) {
      if (!target.members.some((t) => t.name === m.name && t.path === m.path)) {
        throw new Error(`${m.name} is not a member of ${repo.name}.`);
      }
    }
    if (workspace !== null) {
      const { store } = this.deps;
      const refusal = memberChangeRefusal({
        name: repo.name,
        before: store.projects.byId(repo.repoId)?.members ?? [],
        after: registeredProject(workspace, leftOut, null).members,
        running: store.listJobs(repo.repoId).filter((j) => RUNNING_JOB_STATES.includes(j.state))
          .length
      });
      if (refusal !== null) throw new Error(refusal);
    }
    const imported = await importedFiles(repo.repoId, target, input, {
      home: this.home,
      git: this.git
    });
    const { path } = await saveSetup({ repo, setup: input.setup, imported }, this.home);
    if (workspace !== null) {
      this.deps.store.projects.save(registeredProject(workspace, leftOut, input.setup));
    }
    if (opts.finish) this.markDone(repo, 'setup');
    return path;
  }

  /**
   * Check out a submodule setup found missing, so setup can read it. Only a
   * submodule `.gitmodules` lists and the client kept can be checked out.
   */
  async checkOutMember(input: { repo: AgencyRepoRef; path: string }): Promise<void> {
    const repo = await this.verified(input.repo);
    const { target, workspace } = await this.target(repo);
    if (workspace?.kind !== 'submodules' || !target.missing.some((m) => m.path === input.path)) {
      throw new Error(`${input.path} is not a missing member of ${repo.name}.`);
    }
    await this.checkOut(repo.root, input.path);
  }

  /** Save, then copy the setup and crew files into the repository's `.fleet/`, uncommitted. */
  async share(input: SaveSetupInput): Promise<string[]> {
    await this.saveSetup(input, { finish: false });
    return shareWithTeam(await this.verified(input.repo), this.home);
  }

  /** One layer of the client's preferences: `you` or a project id. */
  clientFile(layer: string): ClientFileView {
    const { clientFiles } = this.deps;
    return {
      path: clientFiles.path(layer),
      text: clientFiles.read(layer) || null,
      changedOutside: clientFiles.changedOutside(layer),
      uses: Object.fromEntries(this.deps.store.preferences.useCounts(layer))
    };
  }

  /** How much Fleet does on its own in a project. */
  trust(repoId: string): ProjectTrust {
    return this.deps.store.preferences.trust(repoId);
  }

  /** Set a project's trust level from Settings, so its Bridge says what now happens. */
  setTrust(input: { repoId: string; trust: ProjectTrust }): void {
    this.deps.store.preferences.setTrust(input.repoId, input.trust);
    this.deps.emit({ repoId: input.repoId, jobIds: [] });
  }

  /**
   * The repository that speaks for a project where one is needed, such as for
   * its instruction file and its GitHub issues: the project's own repository,
   * or a folder project's first member.
   */
  private gitRoot(repo: AgencyRepoRef): string {
    const project = this.deps.store.projects.byId(repo.repoId);
    if (project?.kind !== 'folder') return repo.root;
    const first = project.members.at(0);
    return first === undefined ? repo.root : join(project.root, first.path);
  }

  async ruleCandidates(repo: AgencyRepoRef): Promise<RuleCandidates[]> {
    return ruleCandidates(this.gitRoot(await this.verified(repo)), this.git);
  }

  /**
   * One Meet you answer: its lines go to the question's layer, told by the
   * client, and the last question's pick sets the project's trust level. The
   * question counts as gone through, answered or skipped. Refused while the
   * layer has an outside change the client has not kept.
   */
  async meetAnswer(input: {
    repo: AgencyRepoRef;
    id: MeetQuestionId;
    answer: MeetAnswer;
  }): Promise<ClientLineResult> {
    const repo = await this.verified(input.repo);
    const { clientFiles, store } = this.deps;
    const question = meetQuestion(input.id);
    const layer = question.layer === 'you' ? YOU_LAYER : repo.repoId;
    const { lines, trust } = meetAnswerResult(question, input.answer);
    if (lines.length > 0) {
      if (clientFiles.changedOutside(layer)) {
        return {
          ok: false,
          reason: 'This file changed outside Fleet. Keep or undo that change in Settings first.'
        };
      }
      clientFiles.merge(layer, {
        name: layer === YOU_LAYER ? 'You' : repo.name,
        lines: lines.map((text) => ({ text, source: YOU_SOURCE }))
      });
    }
    if (trust !== null)
      store.preferences.setTrust(repo.repoId, {
        ...store.preferences.trust(repo.repoId),
        level: trust
      });
    store.preferences.markMeetSeen(layer, [question.id]);
    this.deps.emit({ repoId: repo.repoId, jobIds: [] });
    return { ok: true };
  }

  /**
   * The end of Meet you, or Finish later: write the rules the client picked
   * from the instruction files, and mark setup done so the Bridge opens. The
   * questions not gone through stay to offer from the Bridge.
   */
  async meetFinish(input: { repo: AgencyRepoRef; rules: ClientLineInput[] }): Promise<void> {
    const repo = await this.verified(input.repo);
    const { clientFiles, store } = this.deps;
    if (input.rules.length > 0) {
      clientFiles.merge(repo.repoId, { name: repo.name, lines: input.rules });
    }
    store.preferences.markMeetSeen(YOU_LAYER, []);
    // A project new to Meet you keeps its unasked questions; one that finished the starter questions has none.
    if (store.onboarding(repo.repoId).starterDoneAt === null) {
      store.preferences.markMeetSeen(repo.repoId, []);
      this.markDone(repo, 'starter');
    } else {
      this.deps.emit({ repoId: repo.repoId, jobIds: [] });
    }
  }

  /** Record an onboarding step done; the snapshot it changes moves the pane on. */
  private markDone(repo: AgencyRepoRef, step: 'setup' | 'starter'): void {
    this.deps.store.markOnboarded(repo, step);
    this.deps.emit({ repoId: repo.repoId, jobIds: [] });
  }

  async briefIdeas(repo: AgencyRepoRef): Promise<BriefIdeas> {
    return briefIdeas(this.gitRoot(await this.verified(repo)), { gh: this.gh, git: this.git });
  }
}
