import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrState } from '../../../../shared/agency-jobs';
import { botName, waitingFor } from '../../../../shared/pr-review';
import {
  CHECK_START_LIMIT_MS,
  commentSummary,
  deliveryNote,
  parsePrReview,
  prReview,
  reviewEvents,
  type PrReviewFacts
} from '../pr-reviews';

/**
 * Readiness and bot comments, from GraphQL answers recorded from
 * github.com/langfuse/langfuse, which Greptile and Claude review: #18959,
 * where Greptile reviewed an older commit, and #18923, where it reviewed the
 * newest one.
 */

const recorded = (n: number): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', `langfuse-${n}-review.json`), 'utf8'));
const facts = (n: number): PrReviewFacts => parsePrReview(recorded(n))!;

const WANTS = { requiredChecks: ['license/cla', 'build'], reviewBots: ['greptile-apps[bot]'] };
const PR = { number: 18959, state: 'open' } as PrState;

describe('parsePrReview', () => {
  it('reads the newest commit, its checks, the bots that reviewed it, and the open bot threads', () => {
    const old = facts(18959);
    expect(old.checks).toEqual(new Map([['license/cla', 'passed']]));
    expect(old.committedAt).toBe(Date.parse('2026-10-16T15:06:59Z'));
    // Greptile and Claude reviewed 6ed981e0, an older commit than the head.
    expect(old.reviewedHead).toEqual(new Set());
    expect(old.comments.map((c) => [c.id, c.author, c.path?.split('/').at(-1), c.line])).toEqual([
      [4295378404, 'greptile-apps[bot]', 'summarizeAssembledTrace.ts', 262],
      [4295378408, 'greptile-apps[bot]', 'processTopicsExecution.ts', 951],
      [4295431548, 'claude[bot]', 'processTopicsExecution.ts', 950],
      [4295431556, 'claude[bot]', 'processTopicsExecution.ts', 953],
      [4295431559, 'claude[bot]', 'processTopicsExecution.ts', 262]
    ]);
    expect(old.comments[0].summary).toBe('One bad facet fails others');
    expect(old.comments[0].url).toBe(
      'https://github.com/langfuse/langfuse/pull/18959#discussion_r4295378404'
    );

    expect(facts(18923).reviewedHead).toEqual(new Set(['claude', 'greptile-apps']));
  });

  it('is null for an answer that is not a PR', () => {
    expect(parsePrReview({ data: { repository: { pullRequest: null } } })).toBeNull();
    expect(parsePrReview({ errors: [{ message: 'Could not resolve' }] })).toBeNull();
  });
});

describe('commentSummary', () => {
  it('keeps the first line of text, without badges, images and markup', () => {
    expect(
      commentSummary(
        '<a href="#"><img alt="P2" src="x.svg"></a> **Missing-object test skips real errors**\n\nMore.'
      )
    ).toBe('Missing-object test skips real errors');
    expect(commentSummary('![badge](https://x/y.svg)\n\n## `fetch` can throw')).toBe(
      'fetch can throw'
    );
    const long = commentSummary(`${'word '.repeat(60)}`);
    expect(long).toHaveLength(160);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('prReview', () => {
  const at = Date.parse('2026-10-16T15:06:59Z');

  it('waits for a required check not started yet and a bot that has not reviewed the head', () => {
    const review = prReview(facts(18959), WANTS, at + 60_000);
    expect(review).toMatchObject({ checks: ['build'], bots: ['greptile-apps[bot]'], stuck: [] });
    expect(review.comments).toHaveLength(5);
    expect(waitingFor(review)).toBe('Greptile and the build check');
  });

  it('calls a required check stuck once it has not started for 15 minutes', () => {
    expect(prReview(facts(18959), WANTS, at + CHECK_START_LIMIT_MS).stuck).toEqual(['build']);
  });

  it('is ready when the required checks passed and each bot reviewed the head', () => {
    const review = prReview(facts(18923), { ...WANTS, requiredChecks: ['license/cla'] }, at);
    expect(waitingFor(review)).toBe('');
    // A bot listed without `[bot]`, or in another case, is the same bot.
    expect(
      prReview(facts(18923), { requiredChecks: [], reviewBots: ['Greptile-Apps'] }, at).bots
    ).toEqual([]);
  });
});

describe('reviewEvents', () => {
  const review = prReview(facts(18959), WANTS, Date.parse('2026-10-16T15:08:00Z'));

  it('tells the Admiral about bot comments it has not seen, fenced, and names the step', () => {
    const before = { ...review, comments: review.comments.slice(0, 3) };
    const [event] = reviewEvents(PR, 'builder', before, review);
    expect(event.line).toBe('Claude left 2 comments on PR #18959');
    expect(event.body).toMatch(/^<session-data session="PR #18959 review comments">\n/);
    expect(event.body).toContain(
      'claude[bot] on worker/src/features/topics/processTopicsExecution.ts:953'
    );
    expect(event.body).toContain('Step builder delivered this PR');
    expect(reviewEvents(PR, 'builder', review, review)).toEqual([]);
  });

  it('says once when a required check did not start, and when the PR became ready', () => {
    const stuck = { ...review, stuck: ['build'] };
    expect(reviewEvents(PR, 'builder', review, stuck).map((e) => e.line)).toEqual([
      'build did not start on PR #18959'
    ]);
    expect(reviewEvents(PR, 'builder', stuck, stuck)).toEqual([]);
    const ready = { ...review, checks: [], bots: [], stuck: [] };
    expect(reviewEvents(PR, 'builder', review, ready).map((e) => e.line)).toEqual([
      'PR #18959 is ready'
    ]);
  });

  it('tells the delivery what the PR waits on and the comments already open', () => {
    const note = deliveryNote({ ...PR, review }, 'builder');
    expect(note).toContain(
      'PR #18959 is not ready yet: it waits for Greptile and the build check.'
    );
    expect(note).toContain('Greptile and Claude left 5 comments');
    expect(deliveryNote({ ...PR, state: 'merged', review }, 'builder')).toBe('');
  });
});

describe('botName', () => {
  it('names a bot the way its users do', () => {
    expect(botName('greptile-apps[bot]')).toBe('Greptile');
    expect(botName('coderabbitai[bot]')).toBe('Coderabbitai');
    expect(botName('claude')).toBe('Claude');
  });
});
