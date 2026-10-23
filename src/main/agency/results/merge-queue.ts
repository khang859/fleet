import { jobDisplayId } from '../../../shared/agency';
import type { AgencyResult, PrState } from '../../../shared/agency-jobs';
import { waitingFor } from '../../../shared/pr-review';
import { ghJson, type GhRun } from '../projects/gh';
import { repoFacts } from '../projects/repo-reader';
import { memberOf } from '../projects/workspace-projects';
import type { GitRun } from '../repo-identity';
import type { AgencyStore, AgencyTouched } from '../store/agency-store';
import type { MergeRunRecord } from '../store/result-store';
import { joinOnce } from '../join-once';
import { bumpBranch, type BumpInput } from '../workspaces/umbrella-bump';
import { prAddress, readMergeView, readPr, type PrMergeView } from './gh-pr';
import type { GithubMember, ResultsService } from './index';
import type { PrCards } from './pr-cards';
import { Ticker } from '../ticker';

/** How often a running merge asks GitHub again while it waits on checks. */
export const MERGE_TICK_MS = 30_000;

export const BUMP_LABEL = 'Umbrella pointer bump';

export type MergeQueueDeps = {
  store: AgencyStore;
  gh: GhRun;
  /** Read-only git, for the umbrella's default branch. */
  git: GitRun;
  results: ResultsService;
  prs: PrCards;
  /** Commits and pushes the umbrella bump; returns the worktree it is in. */
  bump: (input: BumpInput) => Promise<{ path: string; branch: string }>;
  changed: (touched: AgencyTouched[]) => void;
};

/** What the next PR in line needs now. */
export type MergeVerdict =
  | { kind: 'merge' }
  | { kind: 'merged' }
  | { kind: 'wait'; note: string }
  | { kind: 'rerun'; note: string }
  | { kind: 'stop'; note: string };

/**
 * The next PR's turn, from what GitHub says and the run so far. After a merge
 * earlier in the run, a PR merges only on checks that ran since, so each PR
 * is checked against the members merged before it; the first time its checks
 * are older, they are asked to run again. Then it waits for the required
 * checks and review bots its member's setup lists.
 */
export function mergeVerdict(view: PrMergeView, run: MergeRunRecord): MergeVerdict {
  const { pr } = view;
  const name = `PR #${pr.number}`;
  if (pr.state === 'merged') return { kind: 'merged' };
  if (pr.state === 'closed') return { kind: 'stop', note: `${name} was closed without merging.` };
  if (pr.draft)
    return { kind: 'stop', note: `${name} is a draft. Mark it ready, then merge again.` };
  if (view.mergeState === 'DIRTY') {
    return { kind: 'stop', note: `${name} has conflicts with its base.` };
  }
  if (pr.checks.failed > 0) {
    return { kind: 'stop', note: `${name} has failing checks.` };
  }
  if (pr.checks.pending > 0) return { kind: 'wait', note: `Waiting for the checks of ${name}.` };
  const stale = run.since !== null && view.checksSince !== null && view.checksSince < run.since;
  if (stale || view.mergeState === 'BEHIND') {
    return run.rerunAt === null
      ? { kind: 'rerun', note: `Asked the checks of ${name} to run again on the updated base.` }
      : { kind: 'wait', note: `Waiting for the checks of ${name} to run again.` };
  }
  const waiting = waitingFor(pr.review);
  if (waiting !== '') return { kind: 'wait', note: `Waiting for ${waiting} on ${name}.` };
  if (view.mergeState === 'BLOCKED') {
    return {
      kind: 'stop',
      note: `GitHub blocks ${name}: its branch rule needs a review or a check first.`
    };
  }
  return { kind: 'merge' };
}

/**
 * Merges a job's PRs when the client asks: one at a time in member order,
 * each after its checks pass on the updated base, then, for an umbrella
 * project, opens the pointer bump PR and merges it last. The run is kept in
 * `merge_runs`, so a restart picks it up where it was.
 */
export class MergeQueue {
  private readonly running = new Map<number, Promise<void>>();
  private readonly ticker = new Ticker();

  constructor(private readonly deps: MergeQueueDeps) {}

  /** The client asked to merge the job's PRs. */
  async start(jobId: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { store } = this.deps;
    const found = store.jobRepo(jobId);
    if (found === null) return { ok: false, reason: `${jobDisplayId(jobId)} is not known.` };
    const { job, repo } = found;
    if (job.state !== 'delivered') {
      return {
        ok: false,
        reason: `${jobDisplayId(jobId)} is ${job.state}; merge once it delivered.`
      };
    }
    const members = await this.deps.results.githubMembers(repo);
    const prs = this.deps.results
      .prsInOrder(jobId, members)
      .filter((r) => r.body.kind === 'pr' && r.body.pr.state !== 'closed');
    if (prs.length === 0) {
      return { ok: false, reason: `${jobDisplayId(jobId)} has no open PRs to merge.` };
    }
    store.merges.begin(
      jobId,
      prs.map((r) => r.id)
    );
    const what = prs.length === 1 ? 'the PR' : `${prs.length} PRs in member order`;
    store.plans.log({ jobId, kind: 'merge', text: `The client asked to merge ${what}.` });
    this.touch(jobId);
    void this.advance(jobId);
    return { ok: true };
  }

  /** Move the job's merge on as far as it can go now. Joins a pass under way. */
  async advance(jobId: number): Promise<void> {
    return joinOnce(this.running, jobId, async () => this.pass(jobId));
  }

  /** At launch, and on each tick: every merge still under way. */
  async advanceAll(): Promise<void> {
    await Promise.all(this.deps.store.merges.running().map(async (id) => this.advance(id)));
  }

  startTicking(intervalMs = MERGE_TICK_MS): void {
    this.ticker.start(() => void this.advanceAll(), intervalMs);
  }

  stopTicking(): void {
    this.ticker.stop();
  }

  private async pass(jobId: number): Promise<void> {
    const { store } = this.deps;
    const repo = store.jobRepo(jobId)?.repo;
    if (repo === undefined) return;
    const members = await this.deps.results.githubMembers(repo);
    for (;;) {
      const run = store.merges.run(jobId);
      if (run?.status !== 'running' || !this.stillDelivered(jobId)) return;
      const next = store.merges.queue(jobId).find((q) => q.status !== 'merged');
      const result = next === undefined ? null : store.results.get(next.id);
      if (result === null) {
        const bump = await this.bumpIfDue(jobId, members);
        if (bump === 'added') continue;
        if (bump === 'none') this.finish(jobId, 'done', 'Every PR merged.');
        return;
      }
      if (!(await this.turn(repo.repoId, result, members, run))) return;
    }
  }

  /** One look at the next PR. True when it merged and the next may go. */
  private async turn(
    repoId: string,
    result: AgencyResult,
    members: GithubMember[],
    run: MergeRunRecord
  ): Promise<boolean> {
    const { store, gh, prs } = this.deps;
    const { jobId } = result;
    if (result.body.kind !== 'pr') return false;
    const url = result.body.pr.url;
    const member = memberOf(members, result.member);
    const cwd = member.root;
    const read = await readMergeView(gh, cwd, url);
    if (read === null) {
      store.merges.waiting(jobId, `GitHub could not be asked about PR #${result.body.pr.number}.`);
      this.touch(jobId);
      return false;
    }
    const view = {
      ...read,
      pr: await prs.withReview(repoId, member, read.pr, result.body.pr.review)
    };
    if (prs.record(result.id, view.pr)) this.touch(jobId);
    const verdict = mergeVerdict(view, run);
    switch (verdict.kind) {
      case 'merged':
        store.merges.merged(result.id, jobId, view.mergeSha);
        return true;
      case 'stop':
        this.finish(jobId, 'failed', verdict.note, result.id);
        return false;
      case 'wait':
        store.merges.waiting(jobId, verdict.note);
        this.touch(jobId);
        return false;
      case 'rerun':
        if (await this.rerunChecks(view, cwd)) {
          store.merges.waiting(jobId, verdict.note, { rerun: true });
          this.touch(jobId);
          return false;
        }
        // Nothing GitHub can run again: the checks it has are the ones there are.
        return this.merge(jobId, result, cwd);
      case 'merge':
        return this.merge(jobId, result, cwd);
    }
  }

  private async merge(jobId: number, result: AgencyResult, cwd: string): Promise<boolean> {
    const { store, gh } = this.deps;
    if (result.body.kind !== 'pr') return false;
    const { url, number } = result.body.pr;
    const resultId = result.id;
    if (!this.stillDelivered(jobId)) return false;
    const out = await gh(['pr', 'merge', url, '--squash'], cwd);
    if (out?.code !== 0) {
      this.finish(jobId, 'failed', `GitHub would not merge PR #${number}.`, resultId);
      return false;
    }
    const after = await readMergeView(gh, cwd, url);
    if (after !== null) this.deps.prs.record(resultId, after.pr);
    store.merges.merged(resultId, jobId, after?.mergeSha ?? null);
    store.plans.log({ jobId, kind: 'merge', text: `PR #${number} merged.` });
    this.touch(jobId);
    return true;
  }

  /**
   * Get the PR's checks to run on the updated base: bring a PR that is behind
   * its base up to date, which runs them on the new head, or else run its
   * head commit's workflows again. False when there was nothing to run.
   */
  private async rerunChecks(view: PrMergeView, cwd: string): Promise<boolean> {
    const { gh } = this.deps;
    if (view.mergeState === 'BEHIND') {
      return (await gh(['pr', 'update-branch', view.pr.url], cwd))?.code === 0;
    }
    const repo = prAddress(view.pr.url)?.repo ?? '';
    const runs = ghJson(
      await gh(
        ['run', 'list', '--repo', repo, '--commit', view.pr.headSha, '--json', 'databaseId'],
        cwd
      )
    );
    const ids = Array.isArray(runs)
      ? runs.flatMap((r: { databaseId?: unknown }) =>
          typeof r.databaseId === 'number' ? [r.databaseId] : []
        )
      : [];
    let asked = 0;
    for (const id of ids) {
      if ((await gh(['run', 'rerun', String(id), '--repo', repo], cwd))?.code === 0) asked += 1;
    }
    return asked > 0;
  }

  /**
   * Once every member PR merged, an umbrella project gets its pointer bump
   * PR, which goes last in the run. A bump that cannot open stops the run.
   */
  private async bumpIfDue(
    jobId: number,
    members: GithubMember[]
  ): Promise<'added' | 'none' | 'failed'> {
    const { store } = this.deps;
    const job = store.getJob(jobId);
    const project = job ? store.projects.byId(job.repoId) : null;
    const umbrella = members.find((m) => m.path === '.');
    if (project?.kind !== 'submodules' || umbrella === undefined) return 'none';
    const queued = store.merges.queue(jobId).map((q) => store.results.get(q.id));
    const branch = bumpBranch(jobId);
    if (queued.some((r) => r?.body.kind === 'pr' && r.body.pr.branch === branch)) return 'none';
    const moved = queued.flatMap((r) => {
      const m = members.find((x) => x.name === r?.member && x.path !== '.');
      return m && r?.merge?.sha ? [{ name: m.name, path: m.path, sha: r.merge.sha }] : [];
    });
    if (moved.length === 0) return 'none';
    try {
      await this.openBump(jobId, umbrella, moved);
      return 'added';
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.finish(jobId, 'failed', `Could not open the umbrella bump PR. ${why}`);
      return 'failed';
    }
  }

  /** Push the bump on the umbrella's default branch, open its PR, and queue it last. */
  private async openBump(
    jobId: number,
    umbrella: GithubMember,
    moved: BumpInput['members']
  ): Promise<void> {
    const { gh } = this.deps;
    const base = (await repoFacts(umbrella.root, this.deps.git)).defaultBranch;
    if (base === null) throw new Error(`${umbrella.name} has no default branch.`);
    const { path, branch } = await this.deps.bump({
      jobId,
      umbrella: { name: umbrella.name, root: umbrella.root },
      base,
      members: moved
    });
    const title = `Move ${moved.map((m) => m.name).join(', ')} to their merged commits`;
    const body = `Moves each submodule ${jobDisplayId(jobId)} changed to the commit its PR merged as.`;
    const out = await gh(
      ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body],
      path
    );
    const url = out?.code === 0 ? out.stdout.trim().split('\n').at(-1) : undefined;
    const pr = url === undefined ? null : await readPr(gh, path, url);
    if (pr === null) throw new Error('GitHub would not open the PR.');
    this.addBump(jobId, umbrella.name, pr);
    await this.deps.results.linkPrs(jobId);
  }

  private addBump(jobId: number, umbrella: string, pr: PrState): void {
    const { store } = this.deps;
    const approved = store.plans.approved(jobId);
    store.tx(() => {
      const r = store.results.insert({
        jobId,
        stepId: 'bump',
        planVersion: approved?.version ?? 0,
        label: BUMP_LABEL,
        listed: true,
        title: pr.title,
        member: umbrella,
        body: { kind: 'pr', pr }
      });
      store.merges.append(jobId, r.id);
      store.plans.log({ jobId, kind: 'result', stepId: 'bump', text: `${r.label}: ${r.title}` });
    });
    this.touch(jobId);
  }

  /** True while the job's merge is under way. */
  merging(jobId: number): boolean {
    return this.deps.store.merges.run(jobId)?.status === 'running';
  }

  /**
   * The job closed or went back to work: its merge ends where it is, and
   * nothing more merges. The client merges again once it delivers again.
   */
  stop(jobId: number, note: string): void {
    const { store } = this.deps;
    if (!this.merging(jobId)) return;
    store.tx(() => {
      store.merges.finish(jobId, 'failed', note);
      store.plans.log({ jobId, kind: 'merge', text: note });
    });
    this.touch(jobId);
  }

  /** Whether the job still waits on its merge; a job that left delivered stops it. */
  private stillDelivered(jobId: number): boolean {
    const state = this.deps.store.getJob(jobId)?.state;
    if (state === 'delivered') return true;
    this.stop(
      jobId,
      state === 'running' || state === 'waiting'
        ? 'The job went back to work before the merge finished.'
        : 'The job closed before the merge finished.'
    );
    return false;
  }

  /** The run ends; the Admiral hears how, and the client sees it on the sheet. */
  private finish(jobId: number, status: 'done' | 'failed', note: string, failed?: number): void {
    const { store } = this.deps;
    const job = store.getJob(jobId);
    store.tx(() => {
      store.merges.finish(jobId, status, note, failed);
      store.plans.log({ jobId, kind: 'merge', text: note });
      if (job) {
        store.enqueueWakeup({
          repoId: job.repoId,
          jobId,
          kind: 'event',
          payload: {
            line: status === 'done' ? 'The merge finished' : 'The merge stopped',
            body:
              status === 'done'
                ? `${note} Tell the client, and accept the job once nothing is left.`
                : `${note} Tell the client what it needs; they can press Merge again after.`
          }
        });
      }
    });
    this.touch(jobId);
  }

  private touch(jobId: number): void {
    const job = this.deps.store.getJob(jobId);
    if (job) this.deps.changed([{ repoId: job.repoId, jobId }]);
  }
}
