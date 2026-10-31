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
export function isTeamPr(pr: PrWire): boolean {
  return (
    TEAM_ROLES.has(pr.author_association) && pr.head.repo?.full_name === pr.base.repo.full_name
  );
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

export async function listOpenPrs(exec: Exec, cwd: string): Promise<OpenPr[]> {
  const out = await exec(
    'gh',
    ['api', 'repos/{owner}/{repo}/pulls?state=open&per_page=50&sort=created&direction=desc'],
    cwd
  );
  return z
    .array(PR_WIRE)
    .parse(JSON.parse(out))
    .map((pr) => ({
      number: pr.number,
      team: isTeamPr(pr),
      draft: pr.draft === true,
      bot: pr.user.type === 'Bot'
    }));
}

/**
 * One detached worktree for a run, with the PR's code. It works for fork PRs
 * too, as GitHub keeps each PR's head under `pull/N/head`. It never copies
 * `.env` files.
 */
export async function makePrWorktree(
  exec: Exec,
  projectPath: string,
  runId: string,
  prNumber: number,
  base: string = join(FLEET_HOME, 'worktrees')
): Promise<{ path: string; sha: string }> {
  const folder = join(base, basename(projectPath));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `run-${runId.slice(0, 8)}`);

  await exec('git', ['fetch', 'origin', `pull/${prNumber}/head`], projectPath);
  const sha = (await exec('git', ['rev-parse', 'FETCH_HEAD'], projectPath)).trim();
  await exec('git', ['worktree', 'add', '--detach', path, sha], projectPath);
  return { path, sha };
}

export async function removeWorktree(exec: Exec, projectPath: string, path: string): Promise<void> {
  await exec('git', ['worktree', 'remove', '--force', path], projectPath);
}

/** The hidden mark in a posted comment, so a crash can never post an item twice. */
export function itemMarker(runId: string, itemId: string): string {
  return `<!-- fleet:item:${runId}:${itemId} -->`;
}

export async function postComment(
  exec: Exec,
  cwd: string,
  prNumber: number,
  body: string
): Promise<void> {
  await exec('gh', ['pr', 'comment', String(prNumber), '--body-file', '-'], cwd, body);
}

/** Every comment on the PR, to look for the marks of items that may have gone out. */
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
