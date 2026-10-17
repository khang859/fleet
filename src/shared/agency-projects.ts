import { z } from 'zod';
import type { AgencyRepoRef } from './agency';

/**
 * Admiral projects as the onboarding screens see them: the folders the picker
 * offers, what setup found in a repository, the setup Fleet saves for it, and
 * the brief ideas the empty lobby offers.
 *
 * Phase 1 projects are one repository each. The saved setup already keeps a
 * list of members, so a workspace of many repositories is more entries in the
 * same file rather than a new format.
 */

/** A folder the project picker offers, after main has looked at it. */
export type ProjectFolder =
  | { path: string; kind: 'not-a-repo' }
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
  kind: z.literal('repo'),
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

/** What a read-only setup scan of a repository hands the setup screen. */
export type SetupScan = {
  repo: AgencyRepoRef;
  /** The findings, already in the shape they are saved in. */
  setup: ProjectSetup;
  /** True when `setup` is the one saved earlier rather than fresh findings. */
  saved: boolean;
  repoFiles: RepoFile[];
  /** A setup a teammate shared in `.fleet/fleet.agency.toml`, if it parses. */
  teamSetup: ProjectSetup | null;
  /** What was read: a branch name, or `working tree` for a repository with no commits. */
  readFrom: string;
  requiredChecksFrom: RequiredChecksSource;
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
