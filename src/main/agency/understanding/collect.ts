import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { jobDisplayId } from '../../../shared/agency';
import { planStepList } from '../../../shared/agency-plan';
import { RULE_FILES, type ReadTag } from '../../../shared/agency-understanding';
import { ghJson, type GhRun } from '../projects/gh';
import { openRepoReader, repoFacts } from '../projects/repo-reader';
import type { GitRun } from '../repo-identity';
import type { AgencyStore } from '../store/agency-store';
import type { PlanVersionRecord } from '../store/plan-store';

/**
 * The readers behind Read your work, one per source, each capped so one
 * source cannot fill the request. They read text the client wrote, never
 * code: instruction files, commit messages, GitHub review comments and pull
 * request descriptions, and what the client did on past jobs. The only file
 * read outside the project is `~/.claude/CLAUDE.md`, by that exact path.
 */

/** One source's text, as the extraction request carries it. */
export type Collected = { tag: ReadTag; items: string[] };

export const READ_CAPS = {
  instructionChars: 8_000,
  commits: 100,
  commitChars: 500,
  reviews: 100,
  reviewChars: 500,
  prs: 30,
  prChars: 1_000,
  jobItems: 40,
  jobChars: 1_000
} as const;

/** The client's own instruction file, under their home folder. */
export const HOME_INSTRUCTIONS = ['.claude', 'CLAUDE.md'] as const;

const RECORD = '\x1e';

/** `text` cut to `max` characters, marked where it was cut. */
export const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** The client's instruction file path, which nothing else under the home folder is. */
export const homeInstructions = (userHome: string): string => join(userHome, ...HOME_INSTRUCTIONS);

export async function homeInstructionsExist(userHome: string): Promise<boolean> {
  return (await stat(homeInstructions(userHome)).catch(() => null))?.isFile() === true;
}

/** The project's `CLAUDE.md` and `AGENTS.md` at the default branch tip, and the client's own. */
export async function readInstructions(
  root: string,
  deps: { git: GitRun; userHome: string }
): Promise<Collected[]> {
  const facts = await repoFacts(root, deps.git);
  const reader = await openRepoReader(root, facts.defaultBranch, deps.git);
  const out: Collected[] = [];
  for (const file of RULE_FILES) {
    const text = (await reader.read(file))?.trim() ?? '';
    if (text !== '') out.push({ tag: file, items: [cut(text, READ_CAPS.instructionChars)] });
  }
  const own = (await readFile(homeInstructions(deps.userHome), 'utf8').catch(() => '')).trim();
  if (own !== '')
    out.push({ tag: 'your CLAUDE.md', items: [cut(own, READ_CAPS.instructionChars)] });
  return out;
}

/** The email git signs the client's commits with here, or null when none is set. */
export async function commitEmail(root: string, git: GitRun): Promise<string | null> {
  const email = await git(['config', '--get', 'user.email'], root);
  return email === null || email === '' ? null : email;
}

/** The client's last commit messages on the checked-out branch, merges left out. */
export async function readCommits(root: string, git: GitRun): Promise<Collected | null> {
  const email = await commitEmail(root, git);
  if (email === null) return null;
  const out = await git(
    [
      'log',
      '--no-merges',
      '--fixed-strings',
      `--author=${email}`,
      '-n',
      String(READ_CAPS.commits),
      `--format=${RECORD}%s%n%b`,
      'HEAD'
    ],
    root
  );
  const items = (out ?? '')
    .split(RECORD)
    .map((m) => m.trim())
    .filter((m) => m !== '')
    .map((m) => cut(m, READ_CAPS.commitChars));
  return items.length === 0 ? null : { tag: 'your commits', items };
}

const REVIEWS_QUERY = `query($q: String!, $login: String!) {
  search(query: $q, type: ISSUE, first: 30) {
    nodes { ... on PullRequest { reviews(author: $login, last: 10) {
      nodes { body comments(first: 30) { nodes { body } } }
    } } }
  }
}`;

const Bodies = z.object({ nodes: z.array(z.object({ body: z.string() })) });

const ReviewSearch = z.object({
  data: z.object({
    search: z.object({
      nodes: z.array(
        z.object({
          reviews: z
            .object({ nodes: z.array(z.object({ body: z.string(), comments: Bodies })) })
            .optional()
        })
      )
    })
  })
});

/** Who the GitHub CLI is signed in as, or null. */
async function ghLogin(gh: GhRun, cwd: string): Promise<string | null> {
  const out = await gh(['api', 'user', '--jq', '.login'], cwd);
  const login = out?.code === 0 ? out.stdout.trim() : '';
  return /^[\w-]+$/.test(login) ? login : null;
}

/** The client's newest review comments on the project's GitHub repository, summaries included. */
export async function readReviews(
  slug: string,
  deps: { gh: GhRun; cwd: string }
): Promise<Collected | null> {
  const login = await ghLogin(deps.gh, deps.cwd);
  if (login === null) return null;
  const parsed = ReviewSearch.safeParse(
    ghJson(
      await deps.gh(
        [
          'api',
          'graphql',
          '-f',
          `query=${REVIEWS_QUERY}`,
          '-f',
          `q=repo:${slug} is:pr reviewed-by:${login} sort:updated-desc`,
          '-f',
          `login=${login}`
        ],
        deps.cwd
      )
    )
  );
  if (!parsed.success) return null;
  const items = parsed.data.data.search.nodes
    .flatMap((pr) => pr.reviews?.nodes ?? [])
    .flatMap((r) => [r.body, ...r.comments.nodes.map((c) => c.body)])
    .map((b) => b.trim())
    .filter((b) => b !== '')
    .slice(0, READ_CAPS.reviews)
    .map((b) => cut(b, READ_CAPS.reviewChars));
  return items.length === 0 ? null : { tag: 'your review comments', items };
}

const PrList = z.array(z.object({ title: z.string(), body: z.string() }));

/** The descriptions of the client's newest pull requests on the project's repository. */
export async function readPrs(
  slug: string,
  deps: { gh: GhRun; cwd: string }
): Promise<Collected | null> {
  const parsed = PrList.safeParse(
    ghJson(
      await deps.gh(
        [
          'pr',
          'list',
          '--repo',
          slug,
          '--author',
          '@me',
          '--state',
          'all',
          '-L',
          String(READ_CAPS.prs),
          '--json',
          'title,body'
        ],
        deps.cwd
      )
    )
  );
  if (!parsed.success) return null;
  const items = parsed.data
    .map((pr) => `${pr.title}\n\n${pr.body.trim()}`.trim())
    .map((t) => cut(t, READ_CAPS.prChars));
  return items.length === 0 ? null : { tag: 'your PR descriptions', items };
}

/** What the client did on one job: plan edits as before and after, turn-down notes, answers. */
function jobItems(
  store: Pick<AgencyStore, 'plans' | 'listQuestions'>,
  repoId: string,
  jobId: number
): string[] {
  const id = jobDisplayId(jobId);
  const versions = store.plans.versions(jobId);
  const items: string[] = [];
  versions.forEach((v: PlanVersionRecord, i) => {
    if (v.author === 'client' && i > 0) {
      const before = versions[i - 1];
      items.push(
        `${id}: you changed plan v${before.version}.\nBefore: ${planStepList(before.plan)}\nAfter: ${planStepList(v.plan)}`
      );
    }
    if (v.status === 'rejected' && (v.decisionNote ?? '').trim() !== '') {
      items.push(`${id}: you turned down plan v${v.version}: ${v.decisionNote}`);
    }
  });
  for (const q of store.listQuestions(repoId, { jobId, statuses: ['answered'] })) {
    if (q.kind !== 'ask') continue;
    const picked = q.answerOption === null ? null : (q.options.at(q.answerOption)?.label ?? null);
    const said = [picked, q.answerText].filter((s) => s !== null && s.trim() !== '').join(': ');
    if (said !== '') items.push(`${id}: asked "${q.question}", you answered "${said}"`);
  }
  return items;
}

/** The jobs with something the client did, newest first. */
export function jobsWithItems(
  store: Pick<AgencyStore, 'plans' | 'listQuestions' | 'listJobs'>,
  repoId: string
): Array<{ jobId: number; items: string[] }> {
  return store
    .listJobs(repoId, { includeTerminal: true })
    .reverse()
    .map((job) => ({ jobId: job.id, items: jobItems(store, repoId, job.id) }))
    .filter((j) => j.items.length > 0);
}

/** What the client did on the project's past Admiral jobs, newest first. */
export function readPastJobs(
  store: Pick<AgencyStore, 'plans' | 'listQuestions' | 'listJobs'>,
  repoId: string
): Collected | null {
  const items = jobsWithItems(store, repoId)
    .flatMap((j) => j.items)
    .slice(0, READ_CAPS.jobItems)
    .map((t) => cut(t, READ_CAPS.jobChars));
  return items.length === 0 ? null : { tag: 'past jobs', items };
}
