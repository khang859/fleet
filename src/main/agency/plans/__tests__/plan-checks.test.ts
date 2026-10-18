import { describe, expect, it } from 'vitest';
import type { MemberBase } from '../../../../shared/agency-jobs';
import { PlanSchema, withLocalBranches, type PlanInput } from '../../../../shared/agency-plan';
import type { CrewRuntime, RuntimeCheck } from '../../../../shared/agency-crew';
import {
  checkPlan,
  pinBases,
  type CrewFacts,
  type MemberFacts,
  type PlanFacts
} from '../plan-checks';

const HEAD = 'b'.repeat(40);
const TIP = 'a'.repeat(40);

const plan = (steps: PlanInput['steps']): ReturnType<typeof PlanSchema.parse> =>
  PlanSchema.parse({ playbook: 'feature', summary: 'S', steps, budget: { usd: 5 } });

const member = (patch: Partial<MemberFacts> = {}): MemberFacts => ({
  name: 'fleet',
  atRoot: false,
  githubSlug: 'acme/fleet',
  dirty: 0,
  hasAdmiralBranch: false,
  defaultBranch: 'main',
  defaultSha: TIP,
  headBranch: 'feat/x',
  headSha: HEAD,
  ...patch
});

const facts = (patch: Partial<PlanFacts> = {}): PlanFacts => ({
  gh: 'ok',
  members: [member()],
  overlap: [],
  pinned: null,
  crew: null,
  envFiles: [],
  ...patch
});

const runtime = (r: CrewRuntime, problems: string[] = []): RuntimeCheck => ({
  runtime: r,
  path: `/usr/local/bin/${r}`,
  version: '9.9.9',
  problems,
  warnings: []
});

const crew = (patch: Partial<CrewFacts> = {}): CrewFacts => ({
  roles: new Map([['builder', 'claude']]),
  runtimes: { claude: runtime('claude') },
  claudeTrust: { folder: '/repo', trusted: true },
  ...patch
});

const PR = plan([{ id: 'builder-1', role: 'builder', title: 'Build', deliverables: ['pr'] }]);
const codes = (p = PR, f = facts()): string[] => checkPlan(p, f).issues.map((i) => i.code);

describe('checkPlan', () => {
  it('finds nothing in a plan the project can meet', () => {
    expect(checkPlan(PR, facts())).toEqual({
      issues: [],
      overlap: [],
      bases: [
        {
          member: 'fleet',
          defaultBranch: 'main',
          defaultSha: TIP,
          headBranch: 'feat/x',
          headSha: HEAD,
          pinned: null
        }
      ],
      envFiles: []
    });
  });

  it.each<[string, Partial<PlanFacts>, string]>([
    ['no GitHub remote', { members: [member({ githubSlug: null })] }, 'fleet has no GitHub remote'],
    ['gh signed out', { gh: 'signed-out' }, 'the GitHub CLI is not signed in'],
    ['gh not installed', { gh: 'not-installed' }, 'the GitHub CLI is not installed']
  ])('blocks a PR with %s and offers a local branch', (_, patch, why) => {
    const [issue] = checkPlan(PR, facts(patch)).issues;
    expect(issue).toEqual({
      code: 'pr-unavailable',
      severity: 'block',
      text: `builder-1 delivers a PR, but ${why}. Deliver a local branch instead.`,
      step: 'builder-1',
      fix: 'use-branch'
    });
  });

  it('lets a local branch through where a PR cannot go', () => {
    const local = facts({ gh: 'signed-out', members: [member({ githubSlug: null })] });
    expect(codes(withLocalBranches(PR), local)).toEqual([]);
    expect(withLocalBranches(PR).steps[0]?.deliverables).toEqual([
      { kind: 'branch', label: 'Local branch' }
    ]);
  });

  it('blocks a member outside the project and a branch named admiral', () => {
    const outside = plan([{ id: 'builder-1', role: 'builder', title: 'B', changes: ['infra'] }]);
    expect(codes(outside)).toEqual(['member-outside-project']);
    expect(codes(PR, facts({ members: [member({ hasAdmiralBranch: true })] }))).toEqual([
      'admiral-branch-exists'
    ]);
  });

  it('blocks a step whose role the crew does not have, once the crew is known', () => {
    const reviewerOnly = facts({
      crew: crew({ roles: new Map([['reviewer', 'claude']]), runtimes: {} })
    });
    expect(codes(PR, reviewerOnly)).toEqual(['unknown-role']);
    expect(checkPlan(PR, reviewerOnly).issues[0]?.text).toBe(
      "builder-1 uses the role builder, which is not one of this project's crew roles."
    );
    expect(codes(PR, facts({ crew: crew() }))).toEqual([]);
  });

  it('blocks steps on a runtime crew cannot use, naming each step once', () => {
    const two = plan([
      { id: 'build', role: 'builder', title: 'Build' },
      { id: 'review', role: 'builder', title: 'Review', runtime: 'eva' }
    ]);
    const checks = checkPlan(
      two,
      facts({
        crew: crew({
          runtimes: {
            claude: runtime('claude'),
            eva: runtime('eva', ['eva is not installed, or not on the PATH a terminal pane gets.'])
          }
        })
      })
    );
    expect(checks.issues).toEqual([
      {
        code: 'runtime-unavailable',
        severity: 'block',
        text: 'review runs on eva. eva is not installed, or not on the PATH a terminal pane gets.'
      }
    ]);
  });

  it('offers the trust step until Claude Code has run in the folder, for Claude steps only', () => {
    const untrusted = crew({ claudeTrust: { folder: '/repo', trusted: false } });
    expect(checkPlan(PR, facts({ crew: untrusted })).issues).toEqual([
      {
        code: 'claude-trust',
        severity: 'warn',
        text: 'Claude Code has not run in /repo yet. Open it there once and trust the folder, or each Claude crew member waits for you at that prompt.',
        fix: 'trust-claude',
        path: '/repo'
      }
    ]);
    const onEva = crew({ ...untrusted, roles: new Map([['builder', 'eva']]), runtimes: {} });
    expect(codes(PR, facts({ crew: onEva }))).toEqual([]);
  });

  it('warns about a dirty main checkout and about overlap with another job', () => {
    const checks = checkPlan(
      PR,
      facts({
        members: [member({ dirty: 3 })],
        overlap: [{ jobId: 4, member: 'fleet', path: 'src/Sidebar.tsx', step: 'builder-1' }]
      })
    );
    expect(checks.issues.map((i) => [i.code, i.severity])).toEqual([
      ['dirty-main', 'warn'],
      ['overlap', 'warn']
    ]);
    expect(checks.issues[0]?.text).toContain('3 uncommitted changes');
    expect(checks.issues[1]?.text).toBe(
      'j4 is also working on 1 path this plan touches. Ask the client: queue this job behind, or run both?'
    );
    expect(checks.overlap).toHaveLength(1);
  });

  it('pins the umbrella, which every job workspace is made from, though no step names it', () => {
    const f = facts({
      members: [
        member({ name: 'api' }),
        member({ name: 'web' }),
        member({ name: 'shop', atRoot: true })
      ]
    });
    const p = plan([{ id: 'b', role: 'builder', title: 'Build', changes: ['api'] }]);
    expect(checkPlan(p, f).bases.map((b) => b.member)).toEqual(['api', 'shop']);
  });

  it("lists the env files each step gets: its members' and the umbrella's", () => {
    const f = facts({
      members: [
        member({ name: 'api' }),
        member({ name: 'web' }),
        member({ name: 'shop', atRoot: true })
      ],
      envFiles: [
        { member: 'api', file: 'api/.env' },
        { member: 'web', file: 'web/.env.local' },
        { member: 'shop', file: '.env' }
      ]
    });
    const p = plan([
      { id: 'b', role: 'builder', title: 'Build', changes: ['api'] },
      { id: 'q', role: 'qa', title: 'Check', changes: ['shop'], reads: ['web'] }
    ]);
    expect(checkPlan(p, f).envFiles).toEqual([
      { stepId: 'b', files: ['api/.env', '.env'] },
      { stepId: 'q', files: ['web/.env.local', '.env'] }
    ]);
  });

  it('carries the bases an earlier approval pinned', () => {
    const pinned = { fleet: { sha: TIP, from: 'default' as const } };
    expect(checkPlan(PR, facts({ pinned })).bases[0]?.pinned).toEqual(pinned.fleet);
  });
});

describe('pinBases', () => {
  const base = (patch: Partial<MemberBase> = {}): MemberBase => ({
    member: 'fleet',
    defaultBranch: 'main',
    defaultSha: TIP,
    headBranch: 'feat/x',
    headSha: HEAD,
    pinned: null,
    ...patch
  });

  it('pins the default branch tip unless the client picks HEAD', () => {
    expect(pinBases([base()], {})).toEqual({
      ok: true,
      bases: { fleet: { sha: TIP, from: 'default' } }
    });
    expect(pinBases([base()], { fleet: 'head' })).toEqual({
      ok: true,
      bases: { fleet: { sha: HEAD, from: 'head' } }
    });
  });

  it('keeps a pin an earlier approval made', () => {
    const pinned = { sha: 'c'.repeat(40), from: 'default' as const };
    expect(pinBases([base({ pinned })], { fleet: 'head' })).toEqual({
      ok: true,
      bases: { fleet: pinned }
    });
  });

  it('starts from HEAD when the default branch has no commit, and refuses with neither', () => {
    expect(pinBases([base({ defaultSha: null })], {})).toEqual({
      ok: true,
      bases: { fleet: { sha: HEAD, from: 'head' } }
    });
    expect(pinBases([base({ defaultSha: null, headSha: null })], {})).toEqual({
      ok: false,
      reason: 'fleet has no commit to start from.'
    });
  });
});
