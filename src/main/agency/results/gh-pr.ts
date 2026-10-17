import { z } from 'zod';
import type { PrState } from '../../../shared/agency-jobs';
import { ghJson, type GhRun } from '../projects/gh';

/** The fields `gh pr view --json` is asked for: enough for the card, nothing more. */
export const PR_FIELDS = [
  'number',
  'url',
  'title',
  'headRefName',
  'baseRefName',
  'headRefOid',
  'state',
  'isDraft',
  'additions',
  'deletions',
  'changedFiles',
  'statusCheckRollup'
].join(',');

/** A check run reports a conclusion once complete; a commit status reports a state. */
const Check = z.object({
  conclusion: z.string().nullish(),
  state: z.string().nullish(),
  completedAt: z.string().nullish(),
  startedAt: z.string().nullish()
});

const PrView = z.object({
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  isDraft: z.boolean(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  statusCheckRollup: z.array(Check).nullish()
});

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE'
]);

/** How the PR's checks stand: a check with no result yet is pending. */
function countChecks(checks: Array<z.infer<typeof Check>>): PrState['checks'] {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const check of checks) {
    const result = check.conclusion ?? check.state ?? '';
    if (PASSED.has(result)) counts.passed += 1;
    else if (FAILED.has(result)) counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

/** gh's answer as the card's PR, or null when it is not one. */
export function parsePr(json: unknown): PrState | null {
  const parsed = PrView.safeParse(json);
  if (!parsed.success) return null;
  const pr = parsed.data;
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    branch: pr.headRefName,
    base: pr.baseRefName,
    headSha: pr.headRefOid,
    state: pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed',
    draft: pr.isDraft,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    checks: countChecks(pr.statusCheckRollup ?? [])
  };
}

/** Ask GitHub for a PR by its address. Null when gh fails or the answer does not parse. */
export async function readPr(gh: GhRun, cwd: string, url: string): Promise<PrState | null> {
  return parsePr(ghJson(await gh(['pr', 'view', url, '--json', PR_FIELDS], cwd)));
}

/** What the merge queue reads beyond the card. */
export type PrMergeView = {
  pr: PrState;
  /** GitHub's `mergeStateStatus`: `BEHIND` when the base moved on, `DIRTY` on conflicts. */
  mergeState: string;
  /** The commit the merge made on the base, once merged. */
  mergeSha: string | null;
  /**
   * When the oldest check ran: a finished check's end, else its start. Null
   * with no checks. A check not run yet reads as long ago.
   */
  checksSince: number | null;
};

const MERGE_FIELDS = `${PR_FIELDS},mergeStateStatus,mergeCommit`;

const MergeView = PrView.extend({
  mergeStateStatus: z.string(),
  mergeCommit: z.object({ oid: z.string() }).nullish()
});

export function parseMergeView(json: unknown): PrMergeView | null {
  const pr = parsePr(json);
  const parsed = MergeView.safeParse(json);
  if (pr === null || !parsed.success) return null;
  const times = (parsed.data.statusCheckRollup ?? []).map(
    (c) => Date.parse(c.completedAt ?? c.startedAt ?? '') || 0
  );
  return {
    pr,
    mergeState: parsed.data.mergeStateStatus,
    mergeSha: parsed.data.mergeCommit?.oid ?? null,
    checksSince: times.length === 0 ? null : Math.min(...times)
  };
}

export async function readMergeView(
  gh: GhRun,
  cwd: string,
  url: string
): Promise<PrMergeView | null> {
  return parseMergeView(ghJson(await gh(['pr', 'view', url, '--json', MERGE_FIELDS], cwd)));
}

/** `owner/name` of a GitHub pull request address, and its number. */
export function prAddress(url: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(url);
  return m ? { repo: m[1].toLowerCase(), number: Number(m[2]) } : null;
}

/** The `owner/name` of a GitHub remote URL, SSH or HTTPS; null for any other remote. */
export function githubRepo(remote: string | null): string | null {
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote ?? '');
  return m ? m[1].toLowerCase() : null;
}
