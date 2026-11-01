import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { FLEET_HOME } from '../../shared/constants';

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
