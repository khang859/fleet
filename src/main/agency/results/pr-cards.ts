import { ACCEPTS_RESULTS, type AgencyResult, type PrState } from '../../../shared/agency-jobs';
import type { PrReview } from '../../../shared/pr-review';
import { joinOnce } from '../join-once';
import { ghLogin, type GhRun } from '../projects/gh';
import { loadSetup } from '../projects/project-store';
import { memberOf, projectMembers, type ProjectMember } from '../projects/workspace-projects';
import type { AgencyStore, AgencyTouched } from '../store/agency-store';
import { readPr } from './gh-pr';
import { conflictEvent, prReview, readPrReview, reviewEvents } from './pr-reviews';
import { Ticker } from '../ticker';

/** A PR card shown again within this long is not asked of GitHub again. */
export const PR_REFRESH_MAX_AGE_MS = 60_000;

/** How often open PRs of jobs under way are asked about, for checks, bot reviews and comments. */
export const PR_WATCH_MS = 120_000;

export type PrCardsDeps = {
  store: AgencyStore;
  gh: GhRun;
  /** `~/.fleet/agency`, or the test's folder, where each project's setup is. */
  home: () => string;
  now: () => number;
  changed: (touched: AgencyTouched[]) => void;
  /** Every PR of a delivered job is merged on GitHub. */
  allMerged: (jobId: number) => void;
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
  /** The client's GitHub login, read once it is needed and kept for the session. */
  private login: string | null = null;

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
    const found = store.jobRepo(jobId);
    if (found === null) return;
    const { job, repo } = found;
    const { members } = projectMembers(store.projects, repo);
    let changed = false;
    for (const id of store.results.stalePrs(jobId, maxAgeMs, openOnly)) {
      const result = store.results.get(id);
      if (result?.body.kind !== 'pr') continue;
      const member = memberOf(members, result.member);
      const pr = await readPr(this.deps.gh, member.root, result.body.pr.url);
      if (pr === null) continue;
      const seen = await this.withReview(repo.repoId, member, pr, result.body.pr.review);
      if (this.record(id, seen)) changed = true;
    }
    if (changed) this.deps.changed([{ repoId: job.repoId, jobId }]);
    if (job.state === 'delivered' && allMerged(store.results.forJob(jobId))) {
      this.deps.allMerged(jobId);
    }
  }

  /** While jobs under way have open PRs, ask GitHub about them every `intervalMs`. */
  startWatching(intervalMs = PR_WATCH_MS): void {
    this.ticker.start(() => void this.watchAll(intervalMs / 2), intervalMs);
  }

  stopWatching(): void {
    this.ticker.stop();
  }

  async watchAll(maxAgeMs = PR_WATCH_MS / 2): Promise<void> {
    for (const jobId of this.deps.store.results.jobsWithOpenPrs(ACCEPTS_RESULTS)) {
      await this.refreshPrs(jobId, maxAgeMs, true);
    }
  }

  /**
   * What an open PR waits on by its member's setup, and its open comments
   * from the client and the listed bots. When GitHub cannot be read it waits on everything setup lists,
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
    const client = await this.clientLogin(member.root);
    const facts = await readPrReview(this.deps.gh, member.root, pr.url, client);
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

  /** Who the client is on GitHub. A failed read is tried again next time. */
  private async clientLogin(cwd: string): Promise<string | null> {
    this.login ??= await ghLogin(this.deps.gh, cwd);
    return this.login;
  }

  /**
   * Keep what GitHub says about a PR result now, and tell the Admiral what
   * moved in its review since the card last showed it. Returns whether the
   * card changed.
   */
  record(resultId: number, read: PrState): boolean {
    const { store } = this.deps;
    const result = store.results.get(resultId);
    const job = result ? store.getJob(result.jobId) : null;
    if (result?.body.kind !== 'pr' || !job) return false;
    const before = result.body.pr;
    // While GitHub works out whether it conflicts, keep what was known.
    const pr =
      read.conflicts === undefined && before.conflicts !== undefined
        ? { ...read, conflicts: before.conflicts }
        : read;
    const events = [
      ...(pr.review === undefined ? [] : reviewEvents(pr, result.stepId, before.review, pr.review)),
      ...[conflictEvent(pr, result.stepId, before)].filter((e) => e !== null)
    ];
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

/** Whether the results hold a PR, and GitHub last showed each one merged. */
export function allMerged(results: AgencyResult[]): boolean {
  const prs = results.flatMap((r) => (r.body.kind === 'pr' ? [r.body.pr] : []));
  return prs.length > 0 && prs.every((pr) => pr.state === 'merged');
}

/** A delivered PR closed without merging is worth a line in the close summary. */
export function prCloseNotes(results: AgencyResult[]): string[] {
  return results.flatMap((r) =>
    r.body.kind === 'pr' && r.body.pr.state === 'closed'
      ? [`PR #${r.body.pr.number} was closed without merging.`]
      : []
  );
}
