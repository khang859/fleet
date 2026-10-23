import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobDeliverArgs } from '../../../shared/agency-tools';
import { AgencyService } from '../index';
import { exportJob } from '../jobs/job-export';
import { factsGit, REPO } from './fixture';
import { planHelpers } from './plan-helpers';

/** A closed job's record as Markdown. */

let dir: string;
let service: AgencyService;
const clock = { now: new Date(2026, 9, 17, 12, 0).getTime() };
const tick = (minutes: number): void => void (clock.now += minutes * 60_000);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-export-'));
  clock.now = new Date(2026, 9, 17, 12, 0).getTime();
  service = new AgencyService({
    dbPath: join(dir, 'agency.db'),
    emit: () => undefined,
    hasModelKey: () => true,
    now: () => clock.now,
    git: factsGit(),
    agencyHome: join(dir, 'home')
  });
  service.ensureLobby(REPO);
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

const { openJob, startPlan } = planHelpers(() => service, {
  playbook: 'feature',
  summary: 'Add a dark theme behind a toggle in Settings.',
  steps: [
    { id: 'builder-1', role: 'builder', title: 'Build the theme', deliverables: ['branch'] },
    {
      id: 'writer-1',
      role: 'writer',
      title: 'Announce it',
      after: ['builder-1'],
      deliverables: [{ kind: 'copy', label: 'Tweet' }]
    }
  ],
  budget: { usd: 10 },
  asksFirst: ['merge']
});

/** A job that ran start to end: a plan, two questions, two results, then cancelled. */
async function closedJob(): Promise<number> {
  const { job, tools } = openJob();
  tick(5);
  await startPlan(tools);
  tick(1);
  await tools.askClient({
    question: 'Which toggle?',
    context: 'Settings has room for one.',
    options: [{ label: 'Switch' }, { label: 'Menu', detail: 'Under View' }],
    recommended: 1
  });
  const asked = service.snapshot(REPO.repoId).questions.at(-1)!;
  tick(2);
  service.answer({ id: asked.id, option: 0, text: 'and keep it small' });
  // Left open, so delivering the job withdraws it.
  await tools.askClient({
    question: 'Which package manager?',
    context: 'You said so.',
    options: [{ label: 'npm' }, { label: 'pnpm' }],
    recommended: 1
  });
  for (const step of ['builder-1', 'writer-1']) {
    tick(10);
    await tools.jobUpdate!({ step, status: 'running' });
    await tools.jobUpdate!({ step, status: 'done', note: `${step} finished.` });
  }
  await tools.jobDeliver!(
    JobDeliverArgs.parse({ step: 'builder-1', kind: 'branch', branch: 'feat/dark' })
  );
  await tools.jobDeliver!(
    JobDeliverArgs.parse({
      step: 'writer-1',
      kind: 'copy',
      title: 'Launch tweet',
      text: 'Dark mode is here.\nTry it tonight.'
    })
  );
  tick(3);
  service.closeJob({ jobId: job.id, action: 'cancel' });
  await service.cleanup.start(job.id);
  return job.id;
}

describe('job export', () => {
  it('writes the brief, plan, questions and answers, results, steps and record', async () => {
    const jobId = await closedJob();
    const out = await service.exportJob(jobId);
    expect(out?.name).toBe(`j${jobId}-dark-mode.md`);
    expect(out?.text).toMatchSnapshot();
  });

  it('is only for a job that ended', async () => {
    const { job } = openJob();
    expect(await service.exportJob(job.id)).toBeNull();
  });

  it('masks the values of chosen env files wherever they appear', async () => {
    const jobId = await closedJob();
    const detail = service.jobs.detail(jobId)!;
    const text = exportJob(
      {
        project: 'fleet',
        detail: { ...detail, job: { ...detail.job, brief: 'Use key sk_live_123456 and pin 42.' } },
        questions: []
      },
      ['sk_live_123456', '42']
    );
    expect(text).toContain('Use key [redacted:env] and pin 42.');
    expect(text).not.toContain('sk_live_123456');
  });

  it('writes each permission request with who answered it and why, in a fence its target cannot end', async () => {
    const jobId = await closedJob();
    const detail = service.jobs.detail(jobId)!;
    const base = {
      jobId,
      crewId: 1,
      crewLabel: 'builder 1',
      stepId: 'builder-1',
      tool: 'Bash',
      summary: null,
      recommend: null,
      createdAt: clock.now,
      askedAt: null,
      expiresAt: null,
      answeredAt: clock.now
    };
    const text = exportJob({
      project: 'fleet',
      detail: {
        ...detail,
        permissions: [
          {
            ...base,
            id: 1,
            target: 'git push origin feat/dark',
            state: 'allowed',
            answeredBy: 'admiral',
            reason: 'fits step builder-1'
          },
          {
            ...base,
            id: 2,
            target: 'echo ```',
            state: 'denied',
            answeredBy: 'expiry',
            reason: 'The card expired before the client answered.'
          }
        ]
      },
      questions: []
    });
    expect(text).toContain('### p1: builder 1 asked to use Bash on builder-1');
    expect(text).toContain('Allowed by the Admiral 2026-10-17');
    expect(text).toContain(': fits step builder-1');
    expect(text).toContain('````\necho ```\n````');
    expect(text).toContain('Denied by the card expiring');
  });
});
