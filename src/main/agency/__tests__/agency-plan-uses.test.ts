import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { YOU_LAYER, normText } from '../../../shared/agency-client-file';
import { PLAN_MAX_USES, PlanSchema, type PlanInput } from '../../../shared/agency-plan';
import { AgencyService } from '../index';
import { factsGit, fakeGh, REPO } from './fixture';
import { planHelpers } from './plan-helpers';

/** The client's lines a plan follows: `uses`, and how often each line was used. */

const SHIPPED_CREW = fileURLToPath(new URL('../../../../resources/crew', import.meta.url));

let dir: string;
let service: AgencyService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-uses-'));
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

const { openJob, proposeOut, startPlan } = planHelpers(() => service, PLAN);

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
    await startPlan(first.tools, { ...PLAN, uses: ['P1'] });
    await startPlan(first.tools, { ...PLAN, summary: 'Changed.', uses: ['P1', 'Y1'] });
    const counts = (layer: string): number | undefined =>
      service.store.preferences
        .useCounts(layer)
        .get(normText(layer === YOU_LAYER ? 'Never push to main.' : 'Open PRs as drafts.'));
    expect(counts(REPO.repoId)).toBe(1);
    expect(counts(YOU_LAYER)).toBe(1);

    const second = openJob('Another');
    await startPlan(second.tools, { ...PLAN, uses: ['P1'] });
    expect(counts(REPO.repoId)).toBe(2);
    expect(service.projects.clientFile(REPO.repoId).uses[normText('Open PRs as drafts.')]).toBe(2);
  });
});
