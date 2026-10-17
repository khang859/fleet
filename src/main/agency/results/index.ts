import { join, sep } from 'node:path';
import { z } from 'zod';
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
import type { AgencyRepoRef } from '../../../shared/agency';
import { ghJson, type GhRun } from '../projects/gh';
import type { GitRun } from '../repo-identity';
import type { AgencyStore, AgencyTouched } from '../store/agency-store';
import { repoFacts } from '../projects/repo-reader';
import { projectMembers, type ProjectMember } from '../projects/workspace-projects';
import { githubRepo, prAddress, readPr } from './gh-pr';
import { jobLinksSection, withJobLinks, type JobPrLink } from './pr-links';
import type { PrCards } from './pr-cards';
import { deliveryNote } from './pr-reviews';
import { copyResultFiles, resultsDir } from './result-files';

const UNDER_WAY = ['running', 'waiting', 'delivered'];

export type ResultsDeps = {
  store: AgencyStore;
  gh: GhRun;
  git: GitRun;
  /** `~/.fleet/agency`, or the test's folder. */
  home: () => string;
  /** Reads a PR's review for the card a delivery makes. */
  cards: PrCards;
  changed: (touched: AgencyTouched[]) => void;
  /** A new result may complete the job: see `JobsService.afterStepChange`. */
  afterResult: (jobId: number) => void;
};

type Built =
  | { ok: true; body: ResultBody; title: string; member: string | null }
  | { ok: false; reason: string };

const PrBodyView = z.object({ body: z.string() });

/** A project member with the `owner/name` of its GitHub remote, or null when it has none. */
export type GithubMember = ProjectMember & { github: string | null };

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
    const repo = store.repo(job.repoId);
    if (repo === null) return { ok: false, text: 'Not delivered: the project is not known.' };
    const built = await this.build(repo, jobId, args);
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
        member: built.member,
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
    const linked = built.body.kind === 'pr' ? await this.linkPrs(jobId) : 0;
    this.deps.afterResult(jobId);
    this.deps.changed([{ repoId: job.repoId, jobId }]);
    const extra = listed === null ? ' The step did not list it, so it shows as an extra.' : '';
    const review = built.body.kind === 'pr' ? deliveryNote(built.body.pr, step.id) : '';
    const links = linked > 1 ? ` Fleet linked the job's ${linked} PRs to each other.` : '';
    const state = store.getJob(jobId)?.state ?? job.state;
    return {
      ok: true,
      text: `${resultToken(result.id)} "${result.label}" is up for the client as a card.${extra}${links} ${jobDisplayId(jobId)} is ${state}.${review}`
    };
  }

  /** The project's members in member order, each with its GitHub repository. */
  async githubMembers(repo: AgencyRepoRef): Promise<GithubMember[]> {
    const { members } = projectMembers(this.deps.store.projects, repo);
    return Promise.all(
      members.map(async (m) => ({
        ...m,
        github: githubRepo((await repoFacts(m.root, this.deps.git)).remote)
      }))
    );
  }

  /**
   * The job's PR results, newest per PR, in merge order: member order, then
   * delivery order. A PR whose member is gone sorts last.
   */
  prsInOrder(jobId: number, members: readonly ProjectMember[]): AgencyResult[] {
    const newest = new Map<string, AgencyResult>();
    for (const r of this.deps.store.results.forJob(jobId)) {
      if (r.body.kind === 'pr') newest.set(r.body.pr.url, r);
    }
    const place = (r: AgencyResult): number => {
      const i = members.findIndex((m) => m.name === r.member);
      return i === -1 ? members.length : i;
    };
    return [...newest.values()].sort((a, b) => place(a) - place(b) || a.id - b.id);
  }

  /**
   * Write the "Part of job" list into each open PR of the job, so each links
   * the others. Best effort: a PR gh cannot read or edit keeps its body.
   * Returns how many PRs the list names.
   */
  async linkPrs(jobId: number): Promise<number> {
    const job = this.deps.store.getJob(jobId);
    const repo = job ? this.deps.store.repo(job.repoId) : null;
    if (repo === null) return 0;
    const members = await this.githubMembers(repo);
    const prs = this.prsInOrder(jobId, members).flatMap((r) =>
      r.body.kind === 'pr' ? [{ result: r, pr: r.body.pr }] : []
    );
    if (prs.length < 2) return prs.length;
    const links: JobPrLink[] = prs.map(({ result, pr }) => ({
      member: result.member ?? repo.name,
      repo: prAddress(pr.url)?.repo ?? '',
      number: pr.number,
      url: pr.url
    }));
    for (const { result, pr } of prs) {
      if (pr.state !== 'open') continue;
      const cwd = members.find((m) => m.name === result.member)?.root ?? repo.root;
      const read = PrBodyView.safeParse(
        ghJson(await this.deps.gh(['pr', 'view', pr.url, '--json', 'body'], cwd))
      );
      if (!read.success) continue;
      const { body } = read.data;
      const next = withJobLinks(body, jobLinksSection(jobId, links, pr.url));
      if (next !== body) await this.deps.gh(['pr', 'edit', pr.url, '--body', next], cwd);
    }
    return prs.length;
  }

  /** A delivered file's copy, for the client to open: only ever a path in the job's results folder. */
  filePath({ resultId, file }: ResultOpen): string | null {
    const result = this.deps.store.results.get(resultId);
    if (result === null || !('files' in result.body)) return null;
    const path = result.body.files.at(file)?.path ?? '';
    return path.startsWith(resultsDir(this.deps.home(), result.jobId) + sep) ? path : null;
  }

  private async build(repo: AgencyRepoRef, jobId: number, args: JobDeliverArgs): Promise<Built> {
    const { root } = repo;
    const { kind, url, paths, text, branch } = args;
    const title = args.title ?? '';
    const member = null;
    if (kind === 'pr' && url !== undefined) return this.buildPr(repo, url);
    if (kind === 'branch' && branch !== undefined)
      return this.buildBranch(repo, branch, args.member);
    if (kind === 'copy' && text !== undefined) {
      return { ok: true, title, member, body: { kind, text } };
    }
    if ((kind === 'preview' || kind === 'link') && url !== undefined) {
      return { ok: true, title, member, body: { kind, url } };
    }
    if (isFileResultKind(kind) && paths !== undefined) {
      const home = this.deps.home();
      const copied = await copyResultFiles(
        paths,
        [root, join(home, 'jobs', String(jobId))],
        resultsDir(home, jobId),
        args.step
      );
      return copied.ok ? { ok: true, title, member, body: { kind, files: copied.files } } : copied;
    }
    return { ok: false, reason: `a ${kind} result needs ${RESULT_INPUT[kind]}` };
  }

  /** A PR of one of the project members' GitHub remotes, as GitHub has it now. */
  private async buildPr(repo: AgencyRepoRef, url: string): Promise<Built> {
    const address = prAddress(url);
    if (address === null) return { ok: false, reason: `${url} is not a GitHub pull request` };
    const member = (await this.githubMembers(repo)).find((m) => m.github === address.repo);
    if (member === undefined) {
      return { ok: false, reason: `${address.repo} is not this project's GitHub repository` };
    }
    const read = await readPr(this.deps.gh, member.root, url);
    if (read === null) return { ok: false, reason: `gh could not read ${url}` };
    const pr = await this.deps.cards.withReview(repo.repoId, member, read);
    return { ok: true, title: pr.title, member: member.name, body: { kind: 'pr', pr } };
  }

  /** A local branch in the named member, or in the first member that has it. */
  private async buildBranch(repo: AgencyRepoRef, branch: string, name?: string): Promise<Built> {
    const { members } = projectMembers(this.deps.store.projects, repo);
    const named = members.filter((m) => name === undefined || m.name === name);
    if (named.length === 0) return { ok: false, reason: `${name} is not a member of ${repo.name}` };
    for (const m of named) {
      const sha = await this.deps.git(
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        m.root
      );
      if (sha) {
        return {
          ok: true,
          title: branch,
          member: m.name,
          body: { kind: 'branch', branch, sha: sha.trim() }
        };
      }
    }
    return { ok: false, reason: `there is no local branch ${branch}` };
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
