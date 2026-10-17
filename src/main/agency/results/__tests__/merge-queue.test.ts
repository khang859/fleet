import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgencyRepoRef } from '../../../../shared/agency';
import { JobDeliverArgs, type AgentAgencyCapability } from '../../../../shared/agency-tools';
import { approvedJobIn } from '../../__tests__/plan-helpers';
import { AgencyService } from '../../index';
import type { GhRun } from '../../projects/gh';
import { git, shopUmbrella, tempDir } from '../../projects/__tests__/git-fixture';
import type { MergeRunRecord } from '../../store/result-store';
import type { GitWrite } from '../../workspaces/job-workspace';
import { parseMergeView, type PrMergeView } from '../gh-pr';
import { BUMP_LABEL, mergeVerdict } from '../merge-queue';
import { jobLinksSection, withJobLinks } from '../pr-links';

/**
 * The merge of a job's PRs, on a real umbrella with three submodules and a
 * GitHub that answers from responses recorded from github.com/khang859/fleet:
 * each PR is linked to the others, they merge one at a time in member order,
 * each on checks run after the merge before it, and the umbrella's pointer
 * bump is pushed for real and merged last.
 */

const recorded = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Record<string, unknown>;
const VIEW = recorded('pr-654-merge-view.json');
const [CHECK] = VIEW.statusCheckRollup as Array<Record<string, unknown>>;
const RUNS = readFileSync(join(__dirname, 'fixtures', 'runs-654.json'), 'utf8');
const BODY = (recorded('pr-654-body.json') as { body: string }).body;
/** langfuse/langfuse#18923 as GraphQL has it: Greptile reviewed it and opened two threads. */
const REVIEW = recorded('langfuse-18923-review.json') as {
  data: { repository: { pullRequest: { reviewThreads: { nodes: unknown[] } } } };
};
const THREADS = REVIEW.data.repository.pullRequest.reviewThreads.nodes;

const clock = { now: Date.parse('2026-10-17T19:00:00Z') };
const iso = (ms: number): string => new Date(ms).toISOString();

type Check = { conclusion: string | null; completedAt: string | null };
type FakePr = {
  number: number;
  url: string;
  repo: string;
  branch: string;
  state: 'OPEN' | 'MERGED';
  mergeState: string;
  checks: Check[];
  mergeSha: string | null;
  body: string;
  /** Whether Greptile reviewed the head commit, and the threads it opened. */
  botReviewed: boolean;
  threads: unknown[];
};

/** GitHub as the test sets it: PRs by address, and every call made to it. */
const github = { prs: new Map<string, FakePr>(), calls: [] as string[][], created: '' };

/** A PR whose checks passed before the run began, as the recorded PR's did. */
function openPr(
  repo: string,
  number: number,
  checks: Check[] = [passed(CHECK.completedAt)]
): string {
  const url = `https://github.com/${repo}/pull/${number}`;
  github.prs.set(url, {
    number,
    url,
    repo,
    branch: 'admiral/j1/builder-1',
    state: 'OPEN',
    mergeState: 'CLEAN',
    checks,
    mergeSha: null,
    body: BODY,
    botReviewed: false,
    threads: []
  });
  return url;
}

function passed(at: unknown): Check {
  return { conclusion: 'SUCCESS', completedAt: String(at) };
}

const pr = (url: string): FakePr => github.prs.get(url)!;
const headOf = (url: string): string => createHash('sha1').update(`head ${url}`).digest('hex');
const mergeShaOf = (url: string): string => createHash('sha1').update(url).digest('hex');

function view(p: FakePr): Record<string, unknown> {
  return {
    ...VIEW,
    number: p.number,
    url: p.url,
    title: `Change ${p.repo}`,
    headRefName: p.branch,
    headRefOid: headOf(p.url),
    state: p.state,
    mergeStateStatus: p.mergeState,
    mergeCommit: p.mergeSha === null ? null : { oid: p.mergeSha },
    statusCheckRollup: p.checks.map((c) => ({
      ...CHECK,
      status: c.conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: c.conclusion ?? '',
      completedAt: c.completedAt
    }))
  };
}

const ok = (stdout = ''): { code: number; stdout: string } => ({ code: 0, stdout });
const NOT_FOUND = { code: 1, stdout: '' };

const gh: GhRun = async (args, cwd) => {
  github.calls.push(args);
  return Promise.resolve(answer(args, cwd));
};

function answer(args: string[], cwd: string): { code: number; stdout: string } {
  const [cmd, sub] = args;
  if (cmd === 'auth') return ok();
  if (cmd === 'api') return reviewAnswer(args);
  if (cmd === 'run') return runAnswer(args);
  if (cmd === 'pr' && sub === 'create') return ok(createBump(args, cwd));
  return cmd === 'pr' ? prAnswer(args) : NOT_FOUND;
}

/** The PR review GraphQL read, in the recorded answer's shape, from the fake PR. */
function reviewAnswer(args: string[]): { code: number; stdout: string } {
  const field = (name: string): string | undefined =>
    args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  const p = github.prs.get(
    `https://github.com/${field('owner')}/${field('name')}/pull/${field('number')}`
  );
  if (p === undefined || !field('query')?.includes('reviewThreads')) return NOT_FOUND;
  const head = headOf(p.url);
  const contexts = p.checks.map((c) => ({
    __typename: 'CheckRun',
    name: CHECK.name,
    status: c.conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion: c.conclusion
  }));
  const pullRequest = {
    headRefOid: head,
    commits: {
      nodes: [
        {
          commit: {
            committedDate: iso(clock.now),
            statusCheckRollup: { contexts: { nodes: contexts } }
          }
        }
      ]
    },
    reviews: {
      nodes: [
        {
          author: { __typename: 'Bot', login: 'greptile-apps' },
          commit: { oid: p.botReviewed ? head : 'an older commit' }
        }
      ]
    },
    reviewThreads: { nodes: p.threads }
  };
  return ok(JSON.stringify({ data: { repository: { pullRequest } } }));
}

/** `gh run list` finds the recorded run for a known head; `gh run rerun` sets checks running. */
function runAnswer(args: string[]): { code: number; stdout: string } {
  const flag = (name: string): string => args[args.indexOf(name) + 1];
  if (args[1] === 'list') {
    const known = [...github.prs.values()].some((x) => headOf(x.url) === flag('--commit'));
    return ok(known ? RUNS : '[]');
  }
  for (const x of github.prs.values()) {
    if (x.repo === flag('--repo') && x.state === 'OPEN') {
      x.checks = [{ conclusion: null, completedAt: null }];
    }
  }
  return ok();
}

function prAnswer(args: string[]): { code: number; stdout: string } {
  const [, sub, target] = args;
  const p = github.prs.get(target);
  if (p === undefined) return NOT_FOUND;
  if (sub === 'view') return ok(JSON.stringify(args[4] === 'body' ? { body: p.body } : view(p)));
  if (sub === 'edit') {
    p.body = args[args.indexOf('--body') + 1];
    return ok();
  }
  if (sub === 'merge' && p.state === 'OPEN') {
    Object.assign(p, { state: 'MERGED', mergeState: 'UNKNOWN', mergeSha: mergeShaOf(p.url) });
    return ok();
  }
  return NOT_FOUND;
}

/** The umbrella bump PR, opened from its worktree; its checks run after the last merge. */
function createBump(args: string[], cwd: string): string {
  github.created = cwd;
  const url = openPr('shop/shop', 3, [passed(iso(clock.now + 60_000))]);
  pr(url).branch = args[args.indexOf('--head') + 1];
  pr(url).body = args[args.indexOf('--body') + 1];
  return `Creating pull request for ${pr(url).branch} into main in shop/shop\n\n${url}\n`;
}

/** Git that writes, with a fixed identity for the bump commit. */
const gitWrite: GitWrite = async (args, cwd) => {
  let out: string | null;
  try {
    out = `${git(cwd, ...args)}\n`;
  } catch {
    out = null;
  }
  return Promise.resolve(out);
};

let home: { dir: string; cleanup: () => void };
let service: AgencyService;
let root: string;
let origin: string;
let ref: AgencyRepoRef;

/** A job whose one step changes web and core and delivers a PR, approved by the client. */
const approvedJob = async (): Promise<{ jobId: number; tools: AgentAgencyCapability }> =>
  approvedJobIn(service, ref, {
    id: 'builder',
    role: 'builder',
    title: 'Build it',
    changes: ['web', 'core'],
    deliverables: ['pr']
  });

const deliverPr = async (tools: AgentAgencyCapability, url: string): Promise<string> =>
  (await tools.jobDeliver!(JobDeliverArgs.parse({ step: 'builder', kind: 'pr', url }))).text;

function finishStep(jobId: number): void {
  service.store.plans.setStepStatus(jobId, 'builder', 'done');
  service.jobs.afterStepChange(jobId);
  expect(service.store.getJob(jobId)?.state).toBe('delivered');
}

const detail = (jobId: number): NonNullable<ReturnType<typeof service.jobs.detail>> =>
  service.jobs.detail(jobId)!;
const gitlink = (path: string): string =>
  git(origin, 'ls-tree', 'admiral/j1/bump', path).split(/\s+/)[2];

describe('merging a job PR by PR', () => {
  beforeEach(async () => {
    home = tempDir('fleet-merge-');
    clock.now = Date.parse('2026-10-17T19:00:00Z');
    Object.assign(github, { prs: new Map(), calls: [], created: '' });
    service = new AgencyService({
      dbPath: join(home.dir, 'agency.db'),
      emit: () => {},
      hasModelKey: () => true,
      now: () => clock.now,
      gh,
      gitWrite,
      agencyHome: join(home.dir, 'agency-home')
    });
    root = shopUmbrella(home.dir);
    // The members' remotes are on GitHub; the umbrella pushes its bump to a real bare repository.
    for (const name of ['web', 'api', 'core']) {
      git(
        join(root, 'libs', name),
        'remote',
        'set-url',
        'origin',
        `git@github.com:shop/${name}.git`
      );
    }
    origin = join(home.dir, 'shop-origin.git');
    git(home.dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'push', '-q', 'origin', 'main');
    ref = await service.projects.chooseWorkspace({ path: root, leftOut: [] });
  });

  afterEach(() => {
    service.close();
    home.cleanup();
  });

  it('links the PRs, merges them in member order on fresh checks, and bumps the umbrella last', async () => {
    const core = openPr('shop/core', 11);
    const web = openPr('shop/web', 12);
    const { jobId, tools } = await approvedJob();

    expect(await deliverPr(tools, web)).not.toMatch(/linked/);
    expect(await deliverPr(tools, core)).toContain("Fleet linked the job's 2 PRs to each other.");
    // Each body keeps what it said and lists the job's PRs in member order: core before web.
    expect(pr(core).body.startsWith(BODY.trimEnd())).toBe(true);
    expect(pr(core).body).toContain('1. core: shop/core#11 (this PR)\n2. web: shop/web#12\n');
    expect(pr(web).body).toContain('1. core: shop/core#11\n2. web: shop/web#12 (this PR)\n');
    expect(detail(jobId).results.map((r) => r.member)).toEqual(['web', 'core']);

    finishStep(jobId);
    expect(await service.mergePrs(jobId)).toEqual({ ok: true });
    await service.merges.advance(jobId);

    // core goes first. web's checks ran before core merged, so they are asked to run again.
    expect(pr(core).state).toBe('MERGED');
    expect(pr(web).state).toBe('OPEN');
    expect(github.calls).toContainEqual(['run', 'rerun', '39059558735', '--repo', 'shop/web']);
    expect(detail(jobId).merge).toEqual({
      status: 'running',
      note: 'Asked the checks of PR #12 to run again on the updated base.'
    });

    await service.merges.advance(jobId);
    expect(detail(jobId).merge?.note).toBe('Waiting for the checks of PR #12.');

    clock.now += 5 * 60_000;
    pr(web).checks = [passed(iso(clock.now))];
    await service.merges.advance(jobId);

    // web merges, then the bump moves both gitlinks to the merged commits and merges last.
    expect(pr(web).state).toBe('MERGED');
    expect(github.created).toBe(join(home.dir, 'agency-home', 'jobs', '1', 'ws', 'bump'));
    expect(gitlink('libs/core')).toBe(mergeShaOf(core));
    expect(gitlink('libs/web')).toBe(mergeShaOf(web));
    expect(gitlink('libs/api')).toBe(git(join(root, 'libs', 'api'), 'rev-parse', 'HEAD'));
    const bump = 'https://github.com/shop/shop/pull/3';
    expect(pr(bump).state).toBe('MERGED');
    expect(pr(bump).body).toContain('3. shop: shop/shop#3 (this PR)');

    const { results, merge } = detail(jobId);
    expect(merge).toEqual({ status: 'done', note: 'Every PR merged.' });
    expect(results.map((r) => [r.member, r.label, r.merge?.status])).toEqual([
      ['web', 'Branch and PR', 'merged'],
      ['core', 'Branch and PR', 'merged'],
      ['shop', BUMP_LABEL, 'merged']
    ]);
    expect(results.map((r) => r.merge?.sha)).toEqual([
      mergeShaOf(web),
      mergeShaOf(core),
      mergeShaOf(bump)
    ]);
    const merges = github.calls.filter((c) => c[1] === 'merge').map((c) => c[2]);
    expect(merges).toEqual([core, web, bump]);
    expect(service.store.pullWakeups({ repoId: ref.repoId, jobId }).text).toContain(
      'The merge finished'
    );
  });

  it('stops on failing checks, and goes on when the client merges again', async () => {
    const core = openPr('shop/core', 11, [{ conclusion: 'FAILURE', completedAt: iso(clock.now) }]);
    const { jobId, tools } = await approvedJob();
    await deliverPr(tools, core);
    finishStep(jobId);

    await service.mergePrs(jobId);
    await service.merges.advance(jobId);
    expect(pr(core).state).toBe('OPEN');
    expect(detail(jobId).merge).toEqual({ status: 'failed', note: 'PR #11 has failing checks.' });
    expect(detail(jobId).results[0].merge?.status).toBe('failed');
    expect(service.store.pullWakeups({ repoId: ref.repoId, jobId }).text).toContain(
      'The merge stopped'
    );

    pr(core).checks = [passed(iso(clock.now))];
    expect(await service.mergePrs(jobId)).toEqual({ ok: true });
    await service.merges.advance(jobId);
    expect(pr(core).state).toBe('MERGED');
    expect(gitlink('libs/core')).toBe(mergeShaOf(core));
    expect(detail(jobId).merge).toEqual({ status: 'done', note: 'Every PR merged.' });
  });

  it('waits for the review bot setup lists, and tells the Admiral about its comments', async () => {
    const { setup } = await service.projects.scan(ref);
    const members = setup.members.map((m) =>
      m.name === 'core' ? { ...m, requiredChecks: ['ci'], reviewBots: ['greptile-apps[bot]'] } : m
    );
    await service.projects.saveSetup(
      { repo: ref, setup: { ...setup, members }, imports: [] },
      {
        finish: false
      }
    );
    const core = openPr('shop/core', 11);
    const { jobId, tools } = await approvedJob();

    expect(await deliverPr(tools, core)).toContain(
      'PR #11 is not ready yet: it waits for Greptile.'
    );
    finishStep(jobId);
    await service.mergePrs(jobId);
    await service.merges.advance(jobId);
    expect(pr(core).state).toBe('OPEN');
    expect(detail(jobId).merge?.note).toBe('Waiting for Greptile on PR #11.');
    const review = (): unknown => {
      const [r] = detail(jobId).results;
      return r.body.kind === 'pr' ? r.body.pr.review : null;
    };
    expect(review()).toMatchObject({ checks: [], bots: ['greptile-apps[bot]'], comments: [] });

    // Greptile reviews the head and opens two threads; the watch sees it.
    Object.assign(pr(core), { botReviewed: true, threads: THREADS });
    await service.prs.watchAll(0);
    expect(review()).toMatchObject({
      bots: [],
      comments: [
        { author: 'greptile-apps[bot]', path: 'web/src/features/media/server/mediaService.ts' },
        { summary: 'Missing-object test skips real errors' }
      ]
    });
    const told = service.store.pullWakeups({ repoId: ref.repoId, jobId }).text;
    expect(told).toContain('Greptile left 2 comments on PR #11');
    expect(told).toContain('PR #11 is ready');
    await service.prs.watchAll(0);
    expect(service.store.pullWakeups({ repoId: ref.repoId, jobId }).text).toBeNull();

    await service.merges.advance(jobId);
    expect(pr(core).state).toBe('MERGED');
    expect(detail(jobId).merge).toEqual({ status: 'done', note: 'Every PR merged.' });
  });

  it('refuses a job that has not delivered, and a PR outside the project', async () => {
    const { jobId, tools } = await approvedJob();
    expect(await service.mergePrs(jobId)).toEqual({
      ok: false,
      reason: 'j1 is running; merge once it delivered.'
    });
    const elsewhere = openPr('someone/else', 5);
    expect(await deliverPr(tools, elsewhere)).toBe(
      "Not delivered: someone/else is not this project's GitHub repository."
    );
  });
});

describe('mergeVerdict', () => {
  const at = Date.parse(String(CHECK.completedAt));
  const base = parseMergeView({ ...VIEW, state: 'OPEN', mergeStateStatus: 'CLEAN' })!;
  const run = (o: Partial<MergeRunRecord> = {}): MergeRunRecord => ({
    status: 'running',
    note: '',
    since: null,
    rerunAt: null,
    ...o
  });
  const with_ = (
    o: Partial<Omit<PrMergeView, 'pr'>> & { pr?: Partial<PrMergeView['pr']> }
  ): PrMergeView => ({
    ...base,
    ...o,
    pr: { ...base.pr, ...o.pr }
  });

  it('reads the recorded checks time', () => {
    expect(base.checksSince).toBe(at);
    expect(parseMergeView(VIEW)?.mergeSha).toBe('ab077a17a4bf174b258d38a6463fb04241b19489');
  });

  it.each([
    ['a merged PR', with_({ pr: { state: 'merged' } }), run(), 'merged'],
    ['a closed PR', with_({ pr: { state: 'closed' } }), run(), 'stop'],
    ['a draft', with_({ pr: { draft: true } }), run(), 'stop'],
    ['conflicts', with_({ mergeState: 'DIRTY' }), run(), 'stop'],
    [
      'a failing check',
      with_({ pr: { checks: { passed: 0, failed: 1, pending: 0 } } }),
      run(),
      'stop'
    ],
    [
      'a running check',
      with_({ pr: { checks: { passed: 0, failed: 0, pending: 1 } } }),
      run(),
      'wait'
    ],
    ['checks older than the last merge', base, run({ since: at + 1 }), 'rerun'],
    ['checks asked to run again', base, run({ since: at + 1, rerunAt: at + 2 }), 'wait'],
    ['a branch behind its base', with_({ mergeState: 'BEHIND' }), run(), 'rerun'],
    ['a branch rule', with_({ mergeState: 'BLOCKED' }), run(), 'stop'],
    ['passed checks, first in line', base, run(), 'merge'],
    ['checks newer than the last merge', base, run({ since: at - 1 }), 'merge']
  ])('%s', (_name, v, r, kind) => {
    expect(mergeVerdict(v, r).kind).toBe(kind);
  });
});

describe('withJobLinks', () => {
  const links = [
    { member: 'core', repo: 'shop/core', number: 11, url: 'https://github.com/shop/core/pull/11' },
    { member: 'web', repo: 'shop/web', number: 12, url: 'https://github.com/shop/web/pull/12' }
  ];

  it('adds the list below the body, then replaces only the list', () => {
    const once = withJobLinks(BODY, jobLinksSection(1, links, links[0].url));
    expect(once.startsWith(`${BODY.trimEnd()}\n\n<!-- fleet:part-of-job -->`)).toBe(true);
    const again = withJobLinks(`${once}\n\nAdded later.`, jobLinksSection(1, links, links[1].url));
    expect(again).toContain('2. web: shop/web#12 (this PR)');
    expect(again).not.toContain('(this PR)\n2.');
    expect(again.endsWith('Added later.')).toBe(true);
    expect(again.split('fleet:part-of-job').length).toBe(3);
  });

  it('is the whole body of a PR with none', () => {
    expect(withJobLinks('  ', 'x')).toBe(
      '<!-- fleet:part-of-job -->\nx\n<!-- /fleet:part-of-job -->'
    );
  });
});
