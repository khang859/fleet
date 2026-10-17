import type { AgencyPreflight, AgencyRepoRef } from '../../../../shared/agency';
import {
  githubSlug,
  type AgencyProjectSummary,
  type MemberScan,
  type ProjectFolder,
  type ProjectMemberSetup,
  type ProjectSetup,
  type RequiredChecksSource,
  type SetupScan,
  type WorkspaceMember
} from '../../../../shared/agency-projects';
import { displayPath } from '../../../../shared/path-platform';
import { relativeTime } from '../agent/settings/format';

/**
 * What the Admiral's onboarding screens say, worked out apart from how they
 * draw it: what blocks first run, a picker row's badges, setup's notes, the
 * switcher's status and the clone dialog's reading of a pasted repository.
 */

/** A folder as onboarding shows it: `~/Development/fleet`. */
export function homePath(path: string, home: string): string {
  return displayPath(path, 'posix', { homeDir: home, wslHomeByDistro: {} });
}

/** What the Admiral thinks with, as first run shows it once one is set. */
export type FirstRunModel =
  | { kind: 'none' }
  | { kind: 'openrouter'; model: string }
  | { kind: 'local'; model: string };

/**
 * Why "Pick a project" cannot be pressed yet, or null when it can: the
 * Admiral needs a model, and its jobs need at least one crew runtime.
 */
export function pickBlocker(
  preflight: AgencyPreflight | null,
  model: FirstRunModel
): string | null {
  if (model.kind === 'none') return 'Save the Admiral’s model key to go on.';
  if (preflight === null) return 'Checking this Mac…';
  if (!preflight.claude.found && !preflight.eva.found) {
    return 'Install Claude Code or eva so the crew can run.';
  }
  return null;
}

export type FolderBadge = { label: string; tone: 'green' | 'amber' | 'blue' | 'plain' };

/** The project a picker row picks: the repository, or the workspace's own. */
export function folderProject(folder: ProjectFolder): AgencyRepoRef | null {
  if (folder.kind === 'repo') return folder.repo;
  return folder.kind === 'workspace' ? folder.project : null;
}

/** The members a workspace keeps, as the picker shows them, umbrella included. */
export function keptMembers(
  folder: Extract<ProjectFolder, { kind: 'workspace' }>,
  leftOut: readonly string[]
): WorkspaceMember[] {
  return folder.members.filter((m) => !leftOut.includes(m.name));
}

/**
 * The status a picker row leads with: set up, team files waiting, no remote,
 * or not set up. A workspace has no remote when none of its members has one.
 */
export function folderBadges(folder: ProjectFolder, admiralOpen: boolean): FolderBadge[] {
  if (folder.kind === 'not-a-repo') return [];
  const remote =
    folder.kind === 'repo' ? folder.remote : (folder.members.find((m) => m.remote)?.remote ?? null);
  const badges: FolderBadge[] = [];
  if (admiralOpen) badges.push({ label: 'Admiral open', tone: 'blue' });
  if (folder.setupDone) badges.push({ label: 'Set up', tone: 'green' });
  else if (folder.teamFiles) badges.push({ label: 'Has team files to import', tone: 'amber' });
  else if (remote === null) badges.push({ label: 'Local branches only', tone: 'plain' });
  else badges.push({ label: 'Needs setup', tone: 'plain' });
  return badges;
}

/** What a workspace member's row says about it, right of its name. */
export function memberStatus(m: WorkspaceMember): FolderBadge | null {
  if (m.repo === null) return { label: 'Missing', tone: 'amber' };
  if (m.remote === null) return { label: 'Local branches only', tone: 'plain' };
  return null;
}

/** `core → api → web → shop`: the order member PRs merge in. */
export function memberOrder(setup: ProjectSetup): string {
  return setup.members.map((m) => m.name).join(' → ');
}

export const NOTE_DOT = {
  green: 'bg-green-500',
  amber: 'bg-amber-400',
  plain: 'bg-fleet-text-subtle'
};

type RepoNote = { tone: keyof typeof NOTE_DOT; text: string };

/**
 * What the scan could and could not tell about one member, in a sentence
 * each. The teammate's shared setup is said once, on the project's own
 * repository: the umbrella, or the only one.
 */
export function repoNotes(
  scan: SetupScan,
  member: ProjectMemberSetup,
  read: MemberScan
): RepoNote[] {
  const notes: RepoNote[] = [];
  const slug = githubSlug(member.remote);
  const branch = member.defaultBranch ?? 'the default branch';
  if (member.remote === null) {
    notes.push({ tone: 'amber', text: 'No remote, so crew leave local branches for you to push.' });
  } else if (slug === null) {
    notes.push({
      tone: 'plain',
      text: `The remote is not on GitHub, so crew push branches and you open the PRs.`
    });
  } else if (scan.ghSignedIn) {
    notes.push({ tone: 'green', text: `On GitHub as ${slug}, and the GitHub CLI is signed in.` });
  } else {
    notes.push({
      tone: 'amber',
      text: `On GitHub as ${slug}, but the GitHub CLI is not signed in, so crew cannot open PRs.`
    });
  }
  const required: Record<RequiredChecksSource, RepoNote> = {
    'branch-protection': { tone: 'green', text: `Must pass comes from the rules on ${branch}.` },
    'none-found': {
      tone: 'plain',
      text: `${branch} requires no checks, so crew wait for the CI checks.`
    },
    'gh-signed-out': {
      tone: 'plain',
      text: 'Sign in to the GitHub CLI and setup can read the required checks too.'
    },
    'no-github': { tone: 'plain', text: 'Not on GitHub, so there are no required checks to read.' }
  };
  notes.push(required[read.requiredChecksFrom]);
  if (scan.teamSetup !== null && member.path === '.') {
    notes.push({
      tone: 'amber',
      text: 'A teammate shared a setup in .fleet/. Import it below to use it.'
    });
  }
  return notes;
}

/** What the switcher says about a project, right of its name. */
export function projectStatus(p: AgencyProjectSummary): string {
  const parts: string[] = [];
  if (p.openQuestions > 0) {
    parts.push(p.openQuestions === 1 ? '1 question' : `${p.openQuestions} questions`);
  }
  if (p.runningJobs > 0)
    parts.push(p.runningJobs === 1 ? '1 job running' : `${p.runningJobs} jobs running`);
  if (parts.length > 0) return parts.join(' · ');
  if (p.setupDoneAt === null) return 'not set up';
  if (p.starterDoneAt === null) return 'setup unfinished';
  return `set up ${relativeTime(p.setupDoneAt)}`;
}

/** `owner/name` from what someone pasted: a slug, an https URL or an ssh one. */
export function cloneSlug(input: string): string | null {
  const text = input
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(text) ??
    /^git@github\.com:([\w.-]+)\/([\w.-]+)$/.exec(text) ??
    /^([\w.-]+)\/([\w.-]+)$/.exec(text);
  return m ? `${m[1]}/${m[2]}` : null;
}
