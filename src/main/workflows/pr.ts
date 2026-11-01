import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { FLEET_HOME } from '../../shared/constants';
import type { RunBranch } from '../../shared/workflows';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Runs a program in a folder and answers what it printed. Rejects when it fails. */
export type Exec = (
  command: string,
  args: string[],
  cwd: string,
  input?: string
) => Promise<string>;

export const runProgram: Exec = async (command, args, cwd, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd, maxBuffer: MAX_OUTPUT_BYTES, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      }
    );
    if (input !== undefined) child.stdin?.end(input);
  });

export type PrInfo = {
  number: number;
  title: string;
  url: string;
  state: string;
  headSha: string;
  /** The author is a repo member, and the branch is in the same repo. */
  team: boolean;
};

const PR_WIRE = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  merged_at: z.string().nullish(),
  author_association: z.string(),
  user: z.object({ login: z.string(), type: z.string() }),
  head: z.object({
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable()
  }),
  base: z.object({ repo: z.object({ full_name: z.string() }) })
});

export type PrWire = z.infer<typeof PR_WIRE>;

const TEAM_ROLES = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** A team PR: the author belongs to the repo, and the branch is in the same repo. */
function isTeam(role: string, headRepo: string | null | undefined, baseRepo: string): boolean {
  return TEAM_ROLES.has(role) && headRepo === baseRepo;
}

export function isTeamPr(pr: PrWire): boolean {
  return isTeam(pr.author_association, pr.head.repo?.full_name, pr.base.repo.full_name);
}

function infoOf(pr: PrWire): PrInfo {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: pr.merged_at ? 'merged' : pr.state,
    headSha: pr.head.sha,
    team: isTeamPr(pr)
  };
}

/** A PR number from `123`, `#123` or a link. A link can name another repo. */
export function parsePrInput(text: string): { number: number; repo: string | null } | null {
  const trimmed = text.trim();
  const plain = /^#?(\d+)$/.exec(trimmed);
  if (plain) return { number: Number(plain[1]), repo: null };
  const link = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(trimmed);
  return link ? { number: Number(link[2]), repo: link[1] } : null;
}

/** The repo root of a folder, or the folder itself when it is not in a repo. */
export async function repoRoot(exec: Exec, path: string): Promise<string> {
  try {
    return (await exec('git', ['rev-parse', '--show-toplevel'], path)).trim();
  } catch {
    return path;
  }
}

export async function repoSlug(exec: Exec, cwd: string): Promise<string> {
  const out = await exec(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    cwd
  );
  return out.trim();
}

export async function fetchPr(exec: Exec, cwd: string, number: number): Promise<PrInfo> {
  const out = await exec('gh', ['api', `repos/{owner}/{repo}/pulls/${number}`], cwd);
  return infoOf(PR_WIRE.parse(JSON.parse(out)));
}

/** Whether `gh` is signed in, with what to do when it is not. */
export async function ghStatus(exec: Exec, cwd: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    await exec('gh', ['auth', 'status'], cwd);
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export type OpenPr = { number: number; team: boolean; draft: boolean; bot: boolean };

/** One line per PR with only what a rule reads, so a big repo stays small. */
const OPEN_PR_FIELDS =
  '.[] | {number, draft, author_association, type: .user.type, ' +
  'head: .head.repo.full_name, base: .base.repo.full_name}';

const OPEN_PR_LINE = z.object({
  number: z.number(),
  draft: z.boolean(),
  author_association: z.string(),
  type: z.string(),
  head: z.string().nullable(),
  base: z.string()
});

/** Every open PR, on all pages. A rule that sees only part of them finds false new ones. */
export async function listOpenPrs(exec: Exec, cwd: string): Promise<OpenPr[]> {
  const path = 'repos/{owner}/{repo}/pulls?state=open&per_page=100&sort=created&direction=desc';
  const out = await exec('gh', ['api', '--paginate', path, '--jq', OPEN_PR_FIELDS], cwd);
  const lines = out.split('\n').filter((line) => line !== '');
  return lines
    .map((line) => OPEN_PR_LINE.parse(JSON.parse(line)))
    .map((pr) => ({
      number: pr.number,
      team: isTeam(pr.author_association, pr.head, pr.base),
      draft: pr.draft,
      bot: pr.type === 'Bot'
    }));
}

/**
 * One detached worktree for a run, with the PR's code. It works for fork PRs
 * too, as GitHub keeps each PR's head under `pull/N/head`. It never copies
 * `.env` files.
 */
export type PrWorktreeSpec = {
  projectPath: string;
  runId: string;
  prNumber: number;
  base?: string;
  /** The commit to use, when a person opens a finished run's agent again. */
  pinnedSha?: string;
};

function slugOfUrl(url: string): string | null {
  return /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1].toLowerCase() ?? null;
}

/** The remote of the repo that `gh` reads. In a fork, that is not `origin`. */
async function prRemote(exec: Exec, cwd: string): Promise<string> {
  const slug = await repoSlug(exec, cwd);
  const remotes = await exec('git', ['remote', '-v'], cwd);
  for (const line of remotes.split('\n')) {
    const [name, url] = line.split(/\s+/);
    if (url && slugOfUrl(url) === slug.toLowerCase()) return name;
  }
  throw new Error(`No git remote points to ${slug}.`);
}

export async function makePrWorktree(
  exec: Exec,
  spec: PrWorktreeSpec
): Promise<{ path: string; sha: string }> {
  const { projectPath, runId, prNumber, pinnedSha } = spec;
  const base = spec.base ?? join(FLEET_HOME, 'worktrees');
  const remote = await prRemote(exec, projectPath);
  const folder = join(base, basename(projectPath));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `run-${runId.slice(0, 8)}`);

  // Not FETCH_HEAD: the repo has one, and a run next to this one can overwrite it.
  const ref = `refs/fleet/runs/${runId}`;
  await exec('git', ['fetch', remote, `+pull/${prNumber}/head:${ref}`], projectPath);
  try {
    const sha = pinnedSha ?? (await exec('git', ['rev-parse', ref], projectPath)).trim();
    await exec('git', ['worktree', 'add', '--detach', path, sha], projectPath);
    return { path, sha };
  } finally {
    // A ref left behind does no harm, so this never fails the run.
    await exec('git', ['update-ref', '-d', ref], projectPath).catch(() => undefined);
  }
}

export async function removeWorktree(exec: Exec, projectPath: string, path: string): Promise<void> {
  await exec('git', ['worktree', 'remove', '--force', path], projectPath);
}

/** Where a run's own worktree lives: one folder per project. */
function runWorktreePath(projectPath: string, runId: string, base: string): string {
  const folder = join(base, basename(projectPath));
  mkdirSync(folder, { recursive: true });
  return join(folder, `run-${runId.slice(0, 8)}`);
}

/** The default branch, with the ref to start from. A repo with no remote uses HEAD. */
async function startPoint(exec: Exec, cwd: string): Promise<{ base: string; ref: string }> {
  try {
    const ref = await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
    const base = ref.trim().replace(/^origin\//, '');
    await exec('git', ['fetch', 'origin', base], cwd).catch(() => undefined);
    return { base, ref: ref.trim() };
  } catch {
    const head = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
    return { base: head, ref: head };
  }
}

async function branchExists(exec: Exec, cwd: string, name: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], cwd);
    return true;
  } catch {
    return false;
  }
}

export type BranchSpec = {
  projectPath: string;
  runId: string;
  slug: string;
  base?: string;
  /** The run's branch, to open its worktree again. */
  existing?: RunBranch;
};

/** A new worktree on a new branch `fleet/<slug>`, from the default branch. */
export async function makeBranchWorktree(
  exec: Exec,
  spec: BranchSpec
): Promise<{ path: string; branch: RunBranch }> {
  const { projectPath, runId, slug, existing } = spec;
  const path = runWorktreePath(projectPath, runId, spec.base ?? join(FLEET_HOME, 'worktrees'));
  if (existing) {
    await exec('git', ['worktree', 'add', path, existing.name], projectPath);
    return { path, branch: existing };
  }
  const { base, ref } = await startPoint(exec, projectPath);
  const taken = await branchExists(exec, projectPath, `fleet/${slug}`);
  const name = taken ? `fleet/${slug}-${runId.slice(0, 6)}` : `fleet/${slug}`;
  await exec('git', ['worktree', 'add', '-b', name, path, ref], projectPath);
  const baseSha = (await exec('git', ['rev-parse', ref], projectPath)).trim();
  return { path, branch: { name, base, baseSha } };
}

/** The change in a folder from a commit, with work that nobody committed yet. */
export async function changesSince(exec: Exec, cwd: string, sha: string): Promise<string> {
  const diff = await exec('git', ['diff', sha], cwd);
  const added = await exec('git', ['ls-files', '--others', '--exclude-standard'], cwd);
  if (!added.trim()) return diff;
  return `${diff}\n# New files with no commit. Read them in the project folder:\n${added}`;
}

/** The commit a folder split from the default branch, or null when none is known. */
export async function forkPoint(exec: Exec, cwd: string): Promise<string | null> {
  try {
    const { ref } = await startPoint(exec, cwd);
    return (await exec('git', ['merge-base', 'HEAD', ref], cwd)).trim();
  } catch {
    return null;
  }
}

/** The remote that takes the push. In a fork it is the person's own, as `origin` is. */
async function pushRemote(exec: Exec, cwd: string): Promise<string> {
  const chosen = await exec('git', ['config', '--get', 'remote.pushDefault'], cwd).catch(() => '');
  if (chosen.trim()) return chosen.trim();
  const remotes = await exec('git', ['remote'], cwd);
  return remotes.split('\n').includes('origin') ? 'origin' : prRemote(exec, cwd);
}

/** The head for `gh`. A branch in a fork needs its owner, as `gh` reads the upstream repo. */
async function prHead(exec: Exec, cwd: string, remote: string, name: string): Promise<string> {
  const slug = slugOfUrl((await exec('git', ['remote', 'get-url', remote], cwd)).trim());
  if (!slug || slug === (await repoSlug(exec, cwd)).toLowerCase()) return name;
  return `${slug.split('/')[0]}:${name}`;
}

export type BranchPrSpec = {
  projectPath: string;
  worktreePath: string | null;
  branch: RunBranch;
  body: string;
};

export type BranchPrResult = { ok: true; number: number; url: string } | { ok: false; why: string };

async function unsavedWork(exec: Exec, worktreePath: string | null): Promise<boolean> {
  if (!worktreePath) return false;
  return (await exec('git', ['status', '--porcelain'], worktreePath)).trim() !== '';
}

/** The first commit subject. It comes from git, so no TOML text reaches `gh`. */
async function prTitle(exec: Exec, cwd: string, { baseSha, name }: RunBranch): Promise<string> {
  const log = await exec('git', ['log', '--reverse', '--format=%s', `${baseSha}..${name}`], cwd);
  return log.split('\n')[0];
}

function prOfUrl(url: string): { number: number; url: string } {
  return { number: Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0), url };
}

/** The PR of a branch, when one is open already: a retry after a lost answer. */
async function openPrOf(exec: Exec, cwd: string, head: string): Promise<string | null> {
  try {
    const url = await exec('gh', ['pr', 'view', head, '--json', 'url', '-q', '.url'], cwd);
    return url.trim() || null;
  } catch {
    return null;
  }
}

/** What stops a PR, or null: no commits, or work that nobody committed. */
async function prBlocker(exec: Exec, spec: BranchPrSpec): Promise<string | null> {
  const { projectPath, worktreePath, branch } = spec;
  const range = `${branch.baseSha}..${branch.name}`;
  const count = await exec('git', ['rev-list', '--count', range], projectPath);
  if (Number(count.trim()) === 0) return 'The branch has no commits.';
  if (await unsavedWork(exec, worktreePath)) {
    return 'The worktree has changes with no commit. Commit them, then try again.';
  }
  return null;
}

/** Push the branch of a run, and open its PR. All arguments come from git and from Fleet. */
export async function openBranchPr(exec: Exec, spec: BranchPrSpec): Promise<BranchPrResult> {
  const { projectPath, branch, body } = spec;
  const why = await prBlocker(exec, spec);
  if (why) return { ok: false, why };

  const remote = await pushRemote(exec, projectPath);
  await exec('git', ['push', '--set-upstream', remote, branch.name], projectPath);
  const head = await prHead(exec, projectPath, remote, branch.name);
  const open = await openPrOf(exec, projectPath, head);
  if (open) return { ok: true, ...prOfUrl(open) };

  const title = await prTitle(exec, projectPath, branch);
  const args = ['pr', 'create', '--head', head, '--base', branch.base];
  const out = await exec('gh', [...args, '--title', title, '--body-file', '-'], projectPath, body);
  return { ok: true, ...prOfUrl(out.trim()) };
}

/** The hidden mark in a posted comment, so a crash can never post an item twice. */
export function reportMarker(runId: string): string {
  return `<!-- fleet:report:${runId} -->`;
}

export async function postComment(
  exec: Exec,
  cwd: string,
  prNumber: number,
  body: string
): Promise<void> {
  await exec('gh', ['pr', 'comment', String(prNumber), '--body-file', '-'], cwd, body);
}

/** Every comment on the PR, to look for the mark of a report that may have gone out. */
export async function listCommentBodies(
  exec: Exec,
  cwd: string,
  prNumber: number
): Promise<string> {
  return exec(
    'gh',
    ['api', '--paginate', `repos/{owner}/{repo}/issues/${prNumber}/comments`, '--jq', '.[].body'],
    cwd
  );
}
