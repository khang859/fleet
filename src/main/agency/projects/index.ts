import type { AgencyChanged, AgencyRepoRef, RepoResolution } from '../../../shared/agency';
import { STARTER_SOURCE } from '../../../shared/agency-client-file';
import type {
  AgencyProjectSummary,
  BriefIdeas,
  ClientFileView,
  ClientLineInput,
  ProjectFolder,
  RepoFile,
  RuleCandidates,
  SaveSetupRequest,
  SetupScan
} from '../../../shared/agency-projects';
import type { GitRun } from '../repo-identity';
import type { AgencyStore } from '../store/agency-store';
import { briefIdeas } from './brief-ideas';
import { ruleCandidates, type ClientFiles } from './client-file';
import { probeFolders } from './folders';
import { nativeGh, type GhRun } from './gh';
import { agencyHome } from './paths';
import { loadSetup, saveSetup, shareWithTeam, type ImportedFile } from './project-store';
import { readOnlyGit } from './repo-reader';
import { readRepoFile, scanProject } from './setup-findings';

export type ProjectsDeps = {
  store: AgencyStore;
  clientFiles: ClientFiles;
  resolve: (path: string) => Promise<RepoResolution>;
  emit: (change: AgencyChanged) => void;
  gh?: GhRun;
  git?: GitRun;
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

  constructor(private readonly deps: ProjectsDeps) {
    this.gh = deps.gh ?? nativeGh;
    this.git = deps.git ?? readOnlyGit;
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
      resolve: this.deps.resolve,
      git: this.git,
      onboarding: (repoId) => this.deps.store.onboarding(repoId)
    });
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

  async scan(repo: AgencyRepoRef): Promise<SetupScan> {
    const checked = await this.verified(repo);
    const [found, saved] = await Promise.all([
      scanProject(checked, { git: this.git, gh: this.gh }),
      loadSetup(checked.repoId, this.home)
    ]);
    return saved === null ? { ...found, saved: false } : { ...found, setup: saved, saved: true };
  }

  private async importedFiles(repo: AgencyRepoRef, paths: string[]): Promise<ImportedFile[]> {
    const found = await scanProject(repo, { git: this.git });
    const importable = new Map<string, RepoFile>(
      found.repoFiles.filter((f) => f.disposition === 'importable').map((f) => [f.path, f])
    );
    const out: ImportedFile[] = [];
    for (const path of paths) {
      const file = importable.get(path);
      if (file === undefined) throw new Error(`${path} is not a file setup can import.`);
      const content = await readRepoFile(repo.root, path, this.git);
      if (content === null || file.sha256 === null) continue;
      out.push({ path, kind: file.kind, sha256: file.sha256, content });
    }
    return out;
  }

  /** Save a project's setup; `finish` also marks setup done, which moves the pane on. */
  async saveSetup(input: SaveSetupInput, opts: { finish: boolean }): Promise<string> {
    const repo = await this.verified(input.repo);
    const imported = await this.importedFiles(repo, input.imports);
    const { path } = await saveSetup({ repo, setup: input.setup, imported }, this.home);
    if (opts.finish) this.markDone(repo, 'setup');
    return path;
  }

  /** Save, then copy the setup and crew files into the repository's `.fleet/`, uncommitted. */
  async share(input: SaveSetupInput): Promise<string[]> {
    await this.saveSetup(input, { finish: false });
    return shareWithTeam(await this.verified(input.repo), this.home);
  }

  clientFile(repoId: string): ClientFileView {
    const { clientFiles } = this.deps;
    return {
      path: clientFiles.path(repoId),
      text: clientFiles.read(repoId) || null,
      changedOutside: clientFiles.changedOutside(repoId)
    };
  }

  async ruleCandidates(repo: AgencyRepoRef): Promise<RuleCandidates[]> {
    return ruleCandidates((await this.verified(repo)).root, this.git);
  }

  /**
   * Write the starter answers and the picked rules to the client file, and
   * mark the starter questions done. Answers from an earlier run are replaced.
   */
  async finishStarter(input: { repo: AgencyRepoRef; lines: ClientLineInput[] }): Promise<string> {
    const repo = await this.verified(input.repo);
    const text = this.deps.clientFiles.merge(repo.repoId, {
      name: repo.name,
      replaceSource: STARTER_SOURCE,
      lines: input.lines
    });
    this.markDone(repo, 'starter');
    return text;
  }

  /** Record an onboarding step done; the snapshot it changes moves the pane on. */
  private markDone(repo: AgencyRepoRef, step: 'setup' | 'starter'): void {
    this.deps.store.markOnboarded(repo, step);
    this.deps.emit({ repoId: repo.repoId, jobIds: [] });
  }

  async briefIdeas(repo: AgencyRepoRef): Promise<BriefIdeas> {
    return briefIdeas((await this.verified(repo)).root, { gh: this.gh, git: this.git });
  }
}
