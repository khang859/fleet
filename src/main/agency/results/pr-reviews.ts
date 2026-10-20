import { z } from 'zod';
import type { PrState } from '../../../shared/agency-jobs';
import { formatList } from '../../../shared/format-list';
import { fence } from '../../../shared/fleet-tools';
import { botName, waitingFor, type PrComment, type PrReview } from '../../../shared/pr-review';
import { ghJson, type GhRun } from '../projects/gh';
import { checkOutcome, prAddress } from './gh-pr';

/** A required check that has not started this long after the newest commit needs the client. */
export const CHECK_START_LIMIT_MS = 15 * 60_000;

/**
 * One GraphQL read of what readiness needs beyond `gh pr view`: the newest
 * commit's checks by name, which commit each review was of, and the review
 * threads with their first comment.
 */
const REVIEW_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
headRefOid
commits(last:1){nodes{commit{committedDate statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}
reviews(last:100){nodes{author{__typename login} commit{oid}}}
reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{databaseId author{__typename login} body path line url}}}}
}}}`;

const Author = z.object({ __typename: z.string(), login: z.string() }).nullable();
const Nodes = <T extends z.ZodType>(node: T): z.ZodObject<{ nodes: z.ZodArray<T> }> =>
  z.object({ nodes: z.array(node) });

const ReviewView = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        headRefOid: z.string(),
        commits: Nodes(
          z.object({
            commit: z.object({
              committedDate: z.string(),
              statusCheckRollup: z
                .object({
                  contexts: Nodes(
                    z.object({
                      name: z.string().optional(),
                      context: z.string().optional(),
                      conclusion: z.string().nullish(),
                      state: z.string().optional()
                    })
                  )
                })
                .nullable()
            })
          })
        ),
        reviews: Nodes(
          z.object({ author: Author, commit: z.object({ oid: z.string() }).nullable() })
        ),
        reviewThreads: Nodes(
          z.object({
            isResolved: z.boolean(),
            comments: Nodes(
              z.object({
                databaseId: z.number().int(),
                author: Author,
                body: z.string(),
                path: z.string().nullable(),
                line: z.number().int().nullable(),
                url: z.string()
              })
            )
          })
        )
      })
    })
  })
});

/** What GitHub says about a PR's readiness, before setup's lists are applied. */
export type PrReviewFacts = {
  /** Each check of the newest commit by its name, as it stands. */
  checks: Map<string, keyof PrState['checks']>;
  /** When the newest commit was made; checks start after it. */
  committedAt: number | null;
  /** The bots that reviewed the newest commit, as setup keys them. */
  reviewedHead: Set<string>;
  /** Open threads a bot started, oldest first. */
  comments: PrComment[];
};

/** `greptile-apps[bot]` and `Greptile-Apps` name the same bot. */
const botKey = (login: string): string => login.toLowerCase().replace(/\[bot\]$/, '');

/** A comment's first line of text, without the badges and markup bots put around it. */
export function commentSummary(body: string): string {
  const line =
    body
      .replace(/<[^>]*>/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .split('\n')
      .map((l) =>
        l
          .replace(/\*\*|__|`/g, '')
          .replace(/^[#>\s-]+/, '')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .find((l) => l !== '') ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

export function parsePrReview(json: unknown): PrReviewFacts | null {
  const parsed = ReviewView.safeParse(json);
  if (!parsed.success) return null;
  const pr = parsed.data.data.repository.pullRequest;
  const head = pr.commits.nodes.at(-1)?.commit;
  const checks = new Map<string, keyof PrState['checks']>();
  for (const c of head?.statusCheckRollup?.contexts.nodes ?? []) {
    const name = c.name ?? c.context;
    if (name !== undefined) checks.set(name, checkOutcome(c.conclusion ?? c.state));
  }
  const bot = (a: z.infer<typeof Author>): a is NonNullable<typeof a> => a?.__typename === 'Bot';
  return {
    checks,
    committedAt: head ? Date.parse(head.committedDate) || null : null,
    reviewedHead: new Set(
      pr.reviews.nodes.flatMap((r) =>
        bot(r.author) && r.commit?.oid === pr.headRefOid ? [botKey(r.author.login)] : []
      )
    ),
    comments: pr.reviewThreads.nodes.flatMap((t): PrComment[] => {
      const first = t.comments.nodes.at(0);
      if (t.isResolved || first === undefined || !bot(first.author)) return [];
      return [
        {
          id: first.databaseId,
          author: `${first.author.login}[bot]`,
          path: first.path,
          line: first.line,
          url: first.url,
          summary: commentSummary(first.body)
        }
      ];
    })
  };
}

export async function readPrReview(
  gh: GhRun,
  cwd: string,
  url: string
): Promise<PrReviewFacts | null> {
  const address = prAddress(url);
  if (address === null) return null;
  const [owner, name] = address.repo.split('/');
  const out = await gh(
    [
      'api',
      'graphql',
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${address.number}`,
      '-f',
      `query=${REVIEW_QUERY}`
    ],
    cwd
  );
  return parsePrReview(ghJson(out));
}

/** What setup says a member's PRs wait on. */
export type ReviewWants = { requiredChecks: string[]; reviewBots: string[] };

/**
 * Setup's lists applied to what GitHub says: the required checks not passed
 * or failed yet, the listed bots that have not reviewed the newest commit,
 * and the required checks that never started.
 */
export function prReview(facts: PrReviewFacts, wants: ReviewWants, now: number): PrReview {
  const late = facts.committedAt !== null && now - facts.committedAt >= CHECK_START_LIMIT_MS;
  return {
    checks: wants.requiredChecks.filter((c) => (facts.checks.get(c) ?? 'pending') === 'pending'),
    bots: wants.reviewBots.filter((b) => !facts.reviewedHead.has(botKey(b))),
    stuck: late ? wants.requiredChecks.filter((c) => !facts.checks.has(c)) : [],
    comments: facts.comments
  };
}

/** What the Admiral hears when a PR's review moves on. */
export type ReviewEvent = { line: string; body: string };

/**
 * The news between two reads of a PR's review: bot comments not seen before,
 * required checks that stopped short of starting, and a PR that became
 * ready. `before` is undefined for the first read, when the delivery itself
 * told the Admiral where the PR stood.
 */
export function reviewEvents(
  pr: PrState,
  step: string,
  before: PrReview | undefined,
  after: PrReview
): ReviewEvent[] {
  const name = `PR #${pr.number}`;
  const events: ReviewEvent[] = [];
  const seen = new Set(before?.comments.map((c) => c.id));
  const fresh = after.comments.filter((c) => !seen.has(c.id));
  if (before !== undefined && fresh.length > 0) events.push(commentsEvent(pr, step, fresh));
  const stuck = after.stuck.filter((c) => !before?.stuck.includes(c));
  if (stuck.length > 0) {
    events.push({
      line: `${formatList(stuck)} did not start on ${name}`,
      body: [
        `The required ${stuck.length === 1 ? 'check' : 'checks'} ${formatList(stuck)} did not start within 15 minutes of the newest commit of ${name}.`,
        "Ask the client with ask_client whether to keep waiting, or to take it off the member's required checks in setup where the branch rule allows.",
        'The job does not merge until it passes or is taken off.'
      ].join(' ')
    });
  }
  if (before !== undefined && waitingFor(before) !== '' && waitingFor(after) === '') {
    events.push({
      line: `${name} is ready`,
      body: `${name} passed its required checks and each review bot reviewed its newest commit. Tell the client it is ready.`
    });
  }
  return events;
}

/** What the Admiral hears when an open PR comes to conflict with its base, or null. */
export function conflictEvent(pr: PrState, step: string, before: PrState): ReviewEvent | null {
  if (pr.state !== 'open' || pr.conflicts !== true || before.conflicts === true) return null;
  return {
    line: `PR #${pr.number} has conflicts with ${pr.base}`,
    body: `Step ${step} delivered this PR, and ${pr.base} has moved on since: GitHub cannot merge it until its branch is brought up to date. Send it to step ${step} to merge ${pr.base} into its branch, settle the conflicts and push, or tell the client why not.`
  };
}

function commentsEvent(pr: PrState, step: string, fresh: PrComment[]): ReviewEvent {
  const bots = formatList([...new Set(fresh.map((c) => botName(c.author)))]);
  const n = fresh.length === 1 ? 'a comment' : `${fresh.length} comments`;
  const quoted = fresh
    .map(
      (c) =>
        `${c.author} on ${c.path ?? 'the PR'}${c.line === null ? '' : `:${c.line}`}: ${c.summary}\n${c.url}`
    )
    .join('\n\n');
  return {
    line: `${bots} left ${n} on PR #${pr.number}`,
    body: [
      fence(`PR #${pr.number} review comments`, quoted),
      `Step ${step} delivered this PR: send the comments to it to fix, or tell the client why not. They stay open on the result card until resolved on GitHub.`
    ].join('\n')
  };
}

/**
 * What the Admiral reads about a PR it just delivered: what it still waits
 * on, and the bot comments already open on it. Later news comes as events.
 */
export function deliveryNote(pr: PrState, step: string): string {
  if (pr.state !== 'open' || pr.review === undefined) return '';
  const parts: string[] = [];
  const waiting = waitingFor(pr.review);
  if (waiting !== '') {
    parts.push(
      `PR #${pr.number} is not ready yet: it waits for ${waiting}. Do not tell the client it is ready; Fleet tells you when it is.`
    );
  }
  if (pr.review.comments.length > 0) {
    const { line, body } = commentsEvent(pr, step, pr.review.comments);
    parts.push(`${line}:\n${body}`);
  }
  return parts.length === 0 ? '' : `\n${parts.join('\n')}`;
}
