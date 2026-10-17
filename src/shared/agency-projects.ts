import { z } from 'zod';
import type { AgencyRepoRef } from './agency';

/**
 * Admiral projects as the onboarding screens see them: the folders the picker
 * offers, what setup found in a repository, the setup Fleet saves for it, and
 * the brief ideas the empty lobby offers.
 *
 * A project is one repository, or a workspace of member repositories: an
 * umbrella repository and its submodules, or a plain folder whose direct
 * child folders are repositories. The saved setup keeps one entry per member
 * in member order, so both are the same file.
 */

/** `repo` is one repository; `submodules` an umbrella and its submodules; `folder` a folder of repositories. */
export type ProjectKind = 'repo' | 'submodules' | 'folder';

/** One member of a workspace project, as the picker and setup find it. */
export type WorkspaceMember = {
  name: string;
  /** Relative to the project root; `.` for the umbrella. */
  path: string;
  /** Null for a submodule that is not checked out yet. */
  repo: AgencyRepoRef | null;
  branch: string | null;
  /** `github.com/owner/name` style, or null when the member has no remote. */
  remote: string | null;
  umbrella: boolean;
  /** The client left it out of the project in the picker. */
  leftOut: boolean;
};

/** A folder the project picker offers, after main has looked at it. */
export type ProjectFolder =
  | { path: string; kind: 'not-a-repo' }
  | {
      path: string;
      kind: 'workspace';
      /** The project: the umbrella repository, or the folder itself. */
      project: AgencyRepoRef;
      projectKind: Exclude<ProjectKind, 'repo'>;
      /** In member order: dependencies first, the umbrella last. */
      members: WorkspaceMember[];
      teamFiles: boolean;
      setupDone: boolean;
    }
  | {
      path: string;
      kind: 'repo';
      repo: AgencyRepoRef;
      /** The checked-out branch of the main checkout, or null when detached. */
      branch: string | null;
      /** `github.com/owner/name` style, or null when the repository has no remote. */
      remote: string | null;
      /** The main checkout has a `.fleet/` folder a teammate may have shared. */
      teamFiles: boolean;
      setupDone: boolean;
    };

/** What kind of thing a file in the repository is, for the setup screen. */
export type RepoFileKind =
  | 'setup'
  | 'role'
  | 'playbook'
  | 'agent'
  | 'skill'
  | 'instructions'
  | 'other';

/**
 * A crew or setup file setup found in the repository. `importable` ones change
 * nothing until the client imports them; `in-place` ones crew read where they
 * are; `not-used` ones no job ever reads.
 */
export type RepoFile = {
  path: string;
  kind: RepoFileKind;
  disposition: 'importable' | 'in-place' | 'not-used';
  /** Hash of the content setup read, so an import can tell a newer one later. */
  sha256: string | null;
};

const Text = z.string().max(2_000);
const List = z.array(z.string().max(400)).max(200);

export const ProjectMemberSetupSchema = z.object({
  name: z.string().min(1).max(200),
  /** Relative to the project root; `.` for a one-repository project. */
  path: z.string().min(1).max(400),
  remote: z.string().max(400).nullable(),
  defaultBranch: z.string().max(200).nullable(),
  stack: List,
  packageManager: z.string().max(80).nullable(),
  /** What a new worktree runs before crew start in it. */
  setupCommand: Text,
  setupTimeoutSec: z.number().int().min(10).max(7_200),
  /** Commands crew run to check their work. */
  checkCommands: List,
  /** CI job names, as GitHub reports them on a pull request. */
  checks: List,
  /** Checks the default branch requires before a merge. */
  requiredChecks: List,
  reviewBots: List
});
export type ProjectMemberSetup = z.infer<typeof ProjectMemberSetupSchema>;

export const ProjectImportSchema = z.object({
  path: z.string().min(1).max(400),
  kind: z.enum(['setup', 'role', 'playbook', 'agent', 'skill', 'instructions', 'other']),
  sha256: z.string().max(64)
});
export type ProjectImport = z.infer<typeof ProjectImportSchema>;

/** The setup Fleet keeps for a project in `fleet.agency.toml`. */
export const ProjectSetupSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['repo', 'submodules', 'folder']),
  name: z.string().min(1).max(200),
  members: z.array(ProjectMemberSetupSchema).min(1).max(50),
  imports: z.array(ProjectImportSchema).max(200)
});
export type ProjectSetup = z.infer<typeof ProjectSetupSchema>;

/** Where the required checks came from, so the screen can say why there are none. */
export type RequiredChecksSource =
  | 'branch-protection'
  | 'none-found'
  | 'gh-signed-out'
  | 'no-github';

/** What the setup screen sends back to save: the setup and the repository files to import, by path. */
export type SaveSetupRequest = {
  repo: AgencyRepoRef;
  setup: ProjectSetup;
  imports: string[];
};

/** What setup read in one member, beside the findings saved in its setup entry. */
export type MemberScan = {
  name: string;
  path: string;
  /** What was read: a branch name, or `working tree` for a repository with no commits. */
  readFrom: string;
  requiredChecksFrom: RequiredChecksSource;
};

/** What a read-only setup scan of a project hands the setup screen. */
export type SetupScan = {
  repo: AgencyRepoRef;
  kind: ProjectKind;
  /** The findings, already in the shape they are saved in, members in member order. */
  setup: ProjectSetup;
  /** True when `setup` is the one saved earlier rather than fresh findings. */
  saved: boolean;
  /** One per member in `setup`, in the same order. */
  members: MemberScan[];
  /** Submodules listed in `.gitmodules` that are not checked out, so setup could not read them. */
  missing: Array<{ name: string; path: string }>;
  /** Crew and setup files in every member, by path from the project root. */
  repoFiles: RepoFile[];
  /** A setup a teammate shared in `.fleet/fleet.agency.toml`, if it parses. */
  teamSetup: ProjectSetup | null;
  ghSignedIn: boolean;
};

/** A project the Admiral knows: one with an Admiral opened before, or set up. */
export type AgencyProjectSummary = {
  repo: AgencyRepoRef;
  setupDoneAt: number | null;
  starterDoneAt: number | null;
  runningJobs: number;
  openQuestions: number;
};

/** A client file as the editor and the starter preview read it. */
export type ClientFileView = {
  path: string;
  text: string | null;
  /** Changed outside Fleet since Fleet last wrote it, and not kept yet. */
  changedOutside: boolean;
};

/** A line the client file can take, with where it came from. */
export type ClientLineInput = { text: string; source: string };

/** Rules found in a repository's agent instruction file. */
export type RuleCandidates = { source: string; rules: string[] };

/** One suggestion for a first brief. Picking it only fills the brief input. */
export type BriefIdea = {
  kind: 'issue' | 'ci' | 'changelog';
  /** The short tag on the chip: `Issue #318`, `Failing CI`, `Changelog`. */
  tag: string;
  title: string;
  /** What goes into the brief input. */
  brief: string;
};

export type BriefIdeas = {
  ideas: BriefIdea[];
  /** Why GitHub ideas are missing, when they are. */
  github: 'ok' | 'not-installed' | 'signed-out' | 'no-remote';
};

/**
 * A remote URL as people say it: `github.com/owner/name`, without the scheme,
 * the user, or `.git`. Anything it cannot read comes back as it was.
 */
export function remoteLabel(url: string): string {
  const scp = /^[\w.-]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(url);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.replace(/\.git$/, '').replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

/** The `owner/name` of a GitHub remote, or null when it is not on github.com. */
export function githubSlug(url: string | null): string | null {
  if (url === null) return null;
  const m = /^github\.com\/([^/]+)\/([^/]+)$/.exec(remoteLabel(url));
  return m ? `${m[1]}/${m[2]}` : null;
}
