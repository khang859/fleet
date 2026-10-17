import type { AgencyResult, PrState } from '../../../shared/agency-jobs';
import type { PrReview } from '../../../shared/pr-review';
import { joinOnce } from '../join-once';
import type { GhRun } from '../projects/gh';
import { loadSetup } from '../projects/project-store';
import { projectMembers, type ProjectMember } from '../projects/workspace-projects';
import type { AgencyStore, AgencyTouched } from '../store/agency-store';
import { readPr } from './gh-pr';
import { prReview, readPrReview, reviewEvents } from './pr-reviews';
import { Ticker } from '../ticker';

/** A PR card shown again within this long is not asked of GitHub again. */
export const PR_REFRESH_MAX_AGE_MS = 60_000;

/** How often open PRs of jobs under way are asked about, for checks, bot reviews and comments. */
export const PR_WATCH_MS = 120_000;

const UNDER_WAY = ['running', 'waiting', 'delivered'];

export type PrCardsDeps = {
  store: AgencyStore;
  gh: GhRun;
  /** `~/.fleet/agency`, or the test's folder, where each project's setup is. */
  home: () => string;
  now: () => number;
  changed: (touched: AgencyTouched[]) => void;
};

/**
 * PR result cards kept as GitHub has them: refreshed when shown, at close,
 * and every two minutes while the job's PRs are open, each with what it
 * still waits on and its open bot comments. What moved in a review since the
 * last look goes to the Admiral.
 */
export class PrCards {
  private readonly refreshing = new Map<number, Promise<void>>();
  private readonly ticker = new Ticker();

  constructor(private readonly deps: PrCardsDeps) {}

  /**
   * Ask GitHub about the job's PR results not asked within `maxAgeMs`, only
   * the open ones with `openOnly`, and tell the panes when one changed. A
   * failed ask keeps what was known. A refresh under way is joined.
   */
  async refreshPrs(
    jobId: number,
    maxAgeMs = PR_REFRESH_MAX_AGE_MS,
    openOnly = false
  ): Promise<void> {
    return joinOnce(this.refreshing, jobId, async () => this.refresh(jobId, maxAgeMs, openOnly));
  }

  private async refresh(jobId: number, maxAgeMs: number, openOnly: boolean): Promise<void> {
    const { store } = this.deps;
    const job = store.getJob(jobId);
    const repo = job ? store.repo(job.repoId) : null;
    if (!job || repo === null) return;
    const { members } = projectMembers(store.projects, repo);
    let changed = false;
    for (const id of store.results.stalePrs(jobId, maxAgeMs, openOnly)) {
      const result = store.results.get(id);
      if (result?.body.kind !== 'pr') continue;
      const member = members.find((m) => m.name === result.member) ?? members[0];
      const pr = await readPr(this.deps.gh, member.root, result.body.pr.url);
      if (pr === null) continue;
      const seen = await this.withReview(repo.repoId, member, pr, result.body.pr.review);
      if (this.record(id, seen)) changed = true;
    }
    if (changed) this.deps.changed([{ repoId: job.repoId, jobId }]);
  }

  /** While jobs under way have open PRs, ask GitHub about them every `intervalMs`. */
  startWatching(intervalMs = PR_WATCH_MS): void {
    this.ticker.start(() => void this.watchAll(intervalMs / 2), intervalMs);
  }

  stopWatching(): void {
    this.ticker.stop();
  }

  async watchAll(maxAgeMs = PR_WATCH_MS / 2): Promise<void> {
    for (const jobId of this.deps.store.results.jobsWithOpenPrs(UNDER_WAY)) {
      await this.refreshPrs(jobId, maxAgeMs, true);
    }
  }

  /**
   * What an open PR waits on by its member's setup, and its open bot
   * comments. When GitHub cannot be read it waits on everything setup lists,
   * and keeps what it knew of the rest.
   */
  async withReview(
    repoId: string,
    member: ProjectMember,
    pr: PrState,
    previous?: PrReview
  ): Promise<PrState> {
    if (pr.state !== 'open') return pr;
    const setup = await loadSetup(repoId, this.deps.home());
    const wants = setup?.members.find((m) => m.name === member.name) ?? {
      requiredChecks: [],
      reviewBots: []
    };
    const facts = await readPrReview(this.deps.gh, member.root, pr.url);
    const review: PrReview =
      facts === null
        ? {
            checks: wants.requiredChecks,
            bots: wants.reviewBots,
            stuck: previous?.stuck ?? [],
            comments: previous?.comments ?? []
          }
        : prReview(facts, wants, this.deps.now());
    return { ...pr, review };
  }

  /**
   * Keep what GitHub says about a PR result now, and tell the Admiral what
   * moved in its review since the card last showed it. Returns whether the
   * card changed.
   */
  record(resultId: number, pr: PrState): boolean {
    const { store } = this.deps;
    const result = store.results.get(resultId);
    const job = result ? store.getJob(result.jobId) : null;
    if (result?.body.kind !== 'pr' || !job) return false;
    const before = result.body.pr.review;
    const events =
      pr.review === undefined ? [] : reviewEvents(pr, result.stepId, before, pr.review);
    return store.tx(() => {
      for (const payload of events) {
        store.enqueueWakeup({ repoId: job.repoId, jobId: job.id, kind: 'event', payload });
      }
      return store.results.observe(resultId, pr);
    });
  }

  /** What the close summary adds about the job's PRs, refreshed first. */
  async closeNotes(jobId: number): Promise<string[]> {
    await this.refreshPrs(jobId, 0);
    return prCloseNotes(this.deps.store.results.forJob(jobId));
  }
}

/** A delivered PR closed without merging is worth a line in the close summary. */
export function prCloseNotes(results: AgencyResult[]): string[] {
  return results.flatMap((r) =>
    r.body.kind === 'pr' && r.body.pr.state === 'closed'
      ? [`PR #${r.body.pr.number} was closed without merging.`]
      : []
  );
}
