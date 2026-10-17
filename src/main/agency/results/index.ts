import { join, sep } from 'node:path';
import { jobDisplayId } from '../../../shared/agency';
import {
  isFileResultKind,
  type AgencyResult,
  type ResultBody,
  type ResultOpen
} from '../../../shared/agency-jobs';
import {
  DELIVERABLE_DEFAULT_LABEL,
  type Deliverable,
  type PlanStep
} from '../../../shared/agency-plan';
import { RESULT_INPUT, type JobDeliverArgs } from '../../../shared/agency-tools';
import type { GhRun } from '../projects/gh';
import type { GitRun } from '../repo-identity';
import type { AgencyStore, AgencyTouched } from '../store/agency-store';
import { repoFacts } from '../projects/repo-reader';
import { githubRepo, prAddress, readPr } from './gh-pr';
import { copyResultFiles, resultsDir } from './result-files';

/** A PR card shown again within this long is not asked of GitHub again. */
export const PR_REFRESH_MAX_AGE_MS = 60_000;

const UNDER_WAY = ['running', 'waiting', 'delivered'];

export type ResultsDeps = {
  store: AgencyStore;
  gh: GhRun;
  git: GitRun;
  /** `~/.fleet/agency`, or the test's folder. */
  home: () => string;
  changed: (touched: AgencyTouched[]) => void;
  /** A new result may complete the job: see `JobsService.afterStepChange`. */
  afterResult: (jobId: number) => void;
};

type Built = { ok: true; body: ResultBody; title: string } | { ok: false; reason: string };

/**
 * What steps hand back: `job_deliver` records a result card, copying files
 * out of the worktree first, and PR cards are refreshed from GitHub when
 * shown and when the job closes.
 */
export class ResultsService {
  constructor(private readonly deps: ResultsDeps) {}

  async deliver(jobId: number, args: JobDeliverArgs): Promise<{ ok: boolean; text: string }> {
    const { store } = this.deps;
    const job = store.getJob(jobId);
    const approved = store.plans.approved(jobId);
    if (!job || approved === null) {
      return { ok: false, text: 'There is no approved plan yet; propose one with job_plan.' };
    }
    if (!UNDER_WAY.includes(job.state)) {
      return { ok: false, text: `${jobDisplayId(jobId)} is ${job.state}; it takes no results.` };
    }
    const step = approved.plan.steps.find((s) => s.id === args.step);
    if (!step || store.plans.step(jobId, args.step)?.status === 'removed') {
      return { ok: false, text: `Step ${args.step} is not in the approved plan.` };
    }
    const built = await this.build(job.repoId, jobId, args);
    if (!built.ok) return { ok: false, text: `Not delivered: ${built.reason}.` };

    const listed = listedDeliverable(step, args);
    const result = store.tx(() => {
      const r = store.results.insert({
        jobId,
        stepId: step.id,
        planVersion: approved.version,
        label: listed?.label ?? args.label ?? DELIVERABLE_DEFAULT_LABEL[args.kind],
        listed: listed !== null,
        title: built.title,
        body: built.body
      });
      store.plans.log({
        jobId,
        kind: 'result',
        stepId: step.id,
        text: `${r.label}: ${r.title}`
      });
      return r;
    });
    this.deps.afterResult(jobId);
    this.deps.changed([{ repoId: job.repoId, jobId }]);
    const extra = listed === null ? ' The step did not list it, so it shows as an extra.' : '';
    const state = store.getJob(jobId)?.state ?? job.state;
    return {
      ok: true,
      text: `${resultToken(result.id)} "${result.label}" is up for the client as a card.${extra} ${jobDisplayId(jobId)} is ${state}.`
    };
  }

  /**
   * Ask GitHub about the job's PR results not asked within `maxAgeMs`, and
   * tell the panes when one changed. A failed ask keeps what was known.
   */
  async refreshPrs(jobId: number, maxAgeMs = PR_REFRESH_MAX_AGE_MS): Promise<void> {
    const { store } = this.deps;
    const job = store.getJob(jobId);
    const root = job ? store.repo(job.repoId)?.root : undefined;
    if (!job || root === undefined) return;
    let changed = false;
    for (const { id, url } of store.results.stalePrs(jobId, maxAgeMs)) {
      const pr = await readPr(this.deps.gh, root, url);
      if (pr !== null && store.results.observe(id, pr)) changed = true;
    }
    if (changed) this.deps.changed([{ repoId: job.repoId, jobId }]);
  }

  /** What the close summary adds about the job's PRs, refreshed first. */
  async closeNotes(jobId: number): Promise<string[]> {
    await this.refreshPrs(jobId, 0);
    return prCloseNotes(this.deps.store.results.forJob(jobId));
  }

  /** A delivered file's copy, for the client to open: only ever a path in the job's results folder. */
  filePath({ resultId, file }: ResultOpen): string | null {
    const result = this.deps.store.results.get(resultId);
    if (result === null || !('files' in result.body)) return null;
    const path = result.body.files.at(file)?.path ?? '';
    return path.startsWith(resultsDir(this.deps.home(), result.jobId) + sep) ? path : null;
  }

  private async build(repoId: string, jobId: number, args: JobDeliverArgs): Promise<Built> {
    const root = this.deps.store.repo(repoId)?.root;
    if (root === undefined) return { ok: false, reason: 'the project is not known' };
    const { kind, url, paths, text, branch } = args;
    const title = args.title ?? '';
    if (kind === 'pr' && url !== undefined) return this.buildPr(root, url);
    if (kind === 'branch' && branch !== undefined) return this.buildBranch(root, branch);
    if (kind === 'copy' && text !== undefined) return { ok: true, title, body: { kind, text } };
    if ((kind === 'preview' || kind === 'link') && url !== undefined) {
      return { ok: true, title, body: { kind, url } };
    }
    if (isFileResultKind(kind) && paths !== undefined) {
      const home = this.deps.home();
      const copied = await copyResultFiles(
        paths,
        [root, join(home, 'jobs', String(jobId))],
        resultsDir(home, jobId),
        args.step
      );
      return copied.ok ? { ok: true, title, body: { kind, files: copied.files } } : copied;
    }
    return { ok: false, reason: `a ${kind} result needs ${RESULT_INPUT[kind]}` };
  }

  /** A PR of one of the project's GitHub remotes, as GitHub has it now. */
  private async buildPr(root: string, url: string): Promise<Built> {
    const address = prAddress(url);
    if (address === null) return { ok: false, reason: `${url} is not a GitHub pull request` };
    const own = githubRepo((await repoFacts(root, this.deps.git)).remote);
    if (own !== address.repo) {
      return { ok: false, reason: `${address.repo} is not this project's GitHub repository` };
    }
    const pr = await readPr(this.deps.gh, root, url);
    if (pr === null) return { ok: false, reason: `gh could not read ${url}` };
    return { ok: true, title: pr.title, body: { kind: 'pr', pr } };
  }

  private async buildBranch(root: string, branch: string): Promise<Built> {
    const sha = await this.deps.git(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      root
    );
    if (!sha) return { ok: false, reason: `there is no local branch ${branch}` };
    return { ok: true, title: branch, body: { kind: 'branch', branch, sha } };
  }
}

/** The token a transcript row carries so the pane can find the result card. */
export function resultToken(resultId: number): string {
  return `result#${resultId}`;
}

/**
 * The step's deliverable a result answers: the one with its kind and label,
 * or with no label given, the first of its kind. Null for an extra.
 */
function listedDeliverable(step: PlanStep, args: JobDeliverArgs): Deliverable | null {
  const label = args.label?.toLowerCase();
  return (
    step.deliverables.find(
      (d) => d.kind === args.kind && (label === undefined || d.label.toLowerCase() === label)
    ) ?? null
  );
}

/** A delivered PR closed without merging is worth a line in the close summary. */
export function prCloseNotes(results: AgencyResult[]): string[] {
  return results.flatMap((r) =>
    r.body.kind === 'pr' && r.body.pr.state === 'closed'
      ? [`PR #${r.body.pr.number} was closed without merging.`]
      : []
  );
}
