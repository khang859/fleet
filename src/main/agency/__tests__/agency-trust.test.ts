import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdmiralThreadScope } from '../../../shared/agency';
import { YOU_LAYER, normText } from '../../../shared/agency-client-file';
import { PLAN_MAX_USES, PlanSchema, type PlanInput } from '../../../shared/agency-plan';
import type { TrustLevel } from '../../../shared/agency-projects';
import { admiralSnapshotNote } from '../admiral/snapshot-note';
import { AgencyService } from '../index';
import { factsGit, fakeGh, REPO } from './fixture';
import { planHelpers } from './plan-helpers';

/** Trust levels and the client's lines a plan follows: auto-start, `uses`, the note. */

const SHIPPED_CREW = fileURLToPath(new URL('../../../../resources/crew', import.meta.url));

let dir: string;
let service: AgencyService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-trust-'));
  service = new AgencyService({
    dbPath: join(dir, 'agency.db'),
    emit: () => undefined,
    hasModelKey: () => true,
    git: factsGit(),
    gh: fakeGh(),
    agencyHome: join(dir, 'home'),
    crewDirs: { bundled: SHIPPED_CREW, user: null },
    checkRuntime: async (runtime) =>
      Promise.resolve({ runtime, path: `/bin/${runtime}`, version: '1.0.0', checks: [] }),
    crew: { stop: async () => Promise.resolve(), livePanes: () => new Set() }
  });
  service.ensureLobby(REPO);
  service.clientFiles.merge(YOU_LAYER, {
    name: 'You',
    lines: [{ text: 'Never push to main.', source: 'you' }]
  });
  service.clientFiles.merge(REPO.repoId, {
    name: REPO.name,
    lines: [
      { text: 'Open PRs as drafts.', source: 'you' },
      { text: 'Use pnpm.', source: 'you' }
    ]
  });
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

const PLAN: PlanInput = {
  playbook: 'feature',
  summary: 'Add dark mode to the settings page.',
  steps: [{ id: 'builder-1', role: 'builder', title: 'Build the toggle' }],
  budget: { usd: 5 }
};

const { openJob, proposeOut, approve } = planHelpers(() => service, PLAN);

const trust = (level: TrustLevel, autoStartUsd: number | null = null): void =>
  service.store.preferences.setTrust(REPO.repoId, { level, autoStartUsd });

const note = (scope: AdmiralThreadScope): string =>
  admiralSnapshotNote(service.store, scope, service.preferencesForNote(scope.repoId));

describe('uses', () => {
  it('keeps the ids of lines the note shows, and says which it left out', async () => {
    const { tools } = openJob();
    const { id, text } = await proposeOut(tools, { ...PLAN, uses: ['y1', 'P2', 'P9', 'P2'] });
    expect(service.store.plans.version(id)?.uses).toEqual([
      { id: 'Y1', layer: 'you', text: 'Never push to main.' },
      { id: 'P2', layer: 'project', text: 'Use pnpm.' }
    ]);
    expect(text).toContain('Left out of `uses`, as no saved line has these ids: P9');
  });

  it('takes at most twenty ids', () => {
    const many = Array.from({ length: PLAN_MAX_USES + 1 }, (_, i) => `P${i + 1}`);
    expect(PlanSchema.safeParse({ ...PLAN, uses: many }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...PLAN, uses: many.slice(1) }).success).toBe(true);
  });

  it('counts a line once per job, however many versions of its plan use it', async () => {
    const first = openJob();
    await approve(first.tools, { ...PLAN, uses: ['P1'] });
    await approve(first.tools, { ...PLAN, summary: 'Changed.', uses: ['P1', 'Y1'] });
    const counts = (layer: string): number | undefined =>
      service.store.preferences
        .useCounts(layer)
        .get(normText(layer === YOU_LAYER ? 'Never push to main.' : 'Open PRs as drafts.'));
    expect(counts(REPO.repoId)).toBe(1);
    expect(counts(YOU_LAYER)).toBe(1);

    const second = openJob('Another');
    await approve(second.tools, { ...PLAN, uses: ['P1'] });
    expect(counts(REPO.repoId)).toBe(2);
    expect(service.projects.clientFile(REPO.repoId).uses[normText('Open PRs as drafts.')]).toBe(2);
  });

  it('counts nothing for a plan that is only proposed', async () => {
    const { tools } = openJob();
    await proposeOut(tools, { ...PLAN, uses: ['P1'] });
    expect(service.store.preferences.useCounts(REPO.repoId).size).toBe(0);
  });
});

describe('auto-start', () => {
  it('waits for the client under Ask me', async () => {
    const { tools } = openJob();
    const { id, text } = await proposeOut(tools);
    expect(service.store.plans.version(id)?.status).toBe('proposed');
    expect(text).not.toContain('started on its own');
  });

  it('starts a small first plan under Show me the PR, and says so', async () => {
    trust('pr');
    const { job, tools } = openJob();
    const out = await tools.jobPlan!(PlanSchema.parse({ ...PLAN, uses: ['P1'] }));
    expect(out.summary).toMatch(/^started plan v1 on its own plan#\d+$/);
    expect(out.text).toContain('Plan v1 started on its own');
    const version = service.store.plans.approved(job.id);
    expect(version).toMatchObject({ status: 'approved', autoStartUsd: 10 });
    expect(service.store.preferences.useCounts(REPO.repoId).size).toBe(1);
    expect(
      service.jobs
        .detail(job.id)
        ?.log.map((l) => l.text)
        .join('\n')
    ).toContain('Plan v1 started on its own: Show me the PR, within $10');
  });

  it('holds a plan over the auto-start limit for the client', async () => {
    trust('ship', 5);
    const { tools } = openJob();
    const { id } = await proposeOut(tools, { ...PLAN, budget: { usd: 6 } });
    expect(service.store.plans.version(id)?.status).toBe('proposed');
    const { id: small } = await proposeOut(openJob('Small').tools, PLAN);
    expect(service.store.plans.version(small)?.autoStartUsd).toBe(5);
  });

  it('holds a plan over the default Claude share for the client', async () => {
    trust('pr');
    const { tools } = openJob();
    const { id } = await proposeOut(tools, { ...PLAN, budget: { usd: 5, weekPct: 20 } });
    expect(service.store.plans.version(id)?.status).toBe('proposed');
  });

  it('holds a plan that brings a new role for the client', async () => {
    trust('pr');
    const { tools } = openJob();
    const { id } = await proposeOut(tools, {
      ...PLAN,
      steps: [{ id: 'migrate', role: 'data-migrator', title: 'Migrate' }],
      newRoles: [
        {
          name: 'data-migrator',
          description: 'Writes database migrations.',
          instructions: 'Run each migration up and down.'
        }
      ]
    });
    expect(service.store.plans.version(id)?.status).toBe('proposed');
  });

  it('holds an eva step whose cost the client has to accept', async () => {
    trust('pr');
    const { tools } = openJob();
    const { id } = await proposeOut(tools, {
      ...PLAN,
      steps: [
        { id: 'builder-1', role: 'builder', title: 'Build', runtime: 'eva', cap: { turns: 20 } }
      ]
    });
    const version = service.store.plans.version(id);
    expect(version?.status).toBe('proposed');
    expect(version?.checks.issues.map((i) => i.severity)).toContain('accept');
  });

  it('turns the client changing a started plan into a plan change card', async () => {
    trust('pr');
    const { job, tools } = openJob();
    const { id } = await proposeOut(tools);
    const result = await service.jobs.decide({
      planVersionId: id,
      action: 'edit',
      plan: PlanSchema.parse({ ...PLAN, summary: 'Smaller.' })
    });
    expect(result.ok).toBe(true);
    const newest = service.store.plans.newest(job.id);
    expect(newest).toMatchObject({ kind: 'change', author: 'client', status: 'proposed' });
    expect(newest?.plan.summary).toBe('Smaller.');
    expect(newest?.autoStartUsd).toBeNull();
  });
});

describe('the note', () => {
  it('says what Fleet does on its own, and nothing under Ask me', () => {
    const scope = { repoId: REPO.repoId, jobId: null };
    expect(note(scope)).not.toContain('trust level');
    trust('pr', 25);
    expect(note(scope)).toContain(
      "The client set this project's trust level to Show me the PR. Fleet itself approves a first plan you propose when it adds no roles, passes every check, and stays within $25.00 and 10% of the weekly Claude limit"
    );
    expect(note(scope)).not.toContain('merges them');
    trust('ship');
    expect(note(scope)).toContain('within $10.00');
    expect(note(scope)).toContain('Fleet merges them and closes the job');
  });
});
