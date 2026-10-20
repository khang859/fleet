import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgencyQuestion } from '../../../shared/agency';
import { lessonTopic } from '../../../shared/agency-lessons';
import type { PlanInput } from '../../../shared/agency-plan';
import { projectCrewDir } from '../crew/catalog';
import { AgencyService } from '../index';
import type { AdmiralCompletion } from '../understanding';
import { factsGit, fakeGh, REPO } from './fixture';
import { planHelpers } from './plan-helpers';

/** Crew lessons: the review after a job, its card, and what answering it writes. */

const SHIPPED_CREW = fileURLToPath(new URL('../../../../resources/crew', import.meta.url));
const BUNDLED_BUILDER = join(SHIPPED_CREW, 'roles', 'builder.md');

const LESSON = {
  role: 'builder',
  cue: 'When the project has a lint step',
  lesson: 'Run lint before you finish.',
  evidence: 'The review sent back lint errors on both PRs.',
  replace: "run the project's checks before you finish.",
  with: "run the project's checks and lint before you finish."
};
const lessonAnswer = (over: Partial<typeof LESSON> = {}): string =>
  JSON.stringify({ lesson: { ...LESSON, ...over } });

let dir: string;
let service: AgencyService;
let answers: string[];
let calls: Array<{ system: string; user: string }>;

const complete: AdmiralCompletion = async (req) => {
  calls.push(req);
  return Promise.resolve({
    text: answers.shift() ?? '{"lesson": null}',
    costUsd: 0,
    cutOff: false
  });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-lessons-'));
  answers = [];
  calls = [];
  service = new AgencyService({
    dbPath: join(dir, 'agency.db'),
    emit: () => undefined,
    hasModelKey: () => true,
    git: factsGit(),
    gh: fakeGh(),
    agencyHome: join(dir, 'home'),
    crewDirs: { bundled: SHIPPED_CREW, user: join(dir, 'user-crew') },
    admiralCompletion: complete,
    checkRuntime: async (runtime) =>
      Promise.resolve({ runtime, path: `/bin/${runtime}`, version: '1.0.0', checks: [] }),
    crew: { stop: async () => Promise.resolve(), livePanes: () => new Set() }
  });
  service.ensureLobby(REPO);
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

const { openJob, approve } = planHelpers(() => service, PLAN);

/** A job whose builder step ran, ended by the client's cancel. */
async function endedJob(stepStatus: 'done' | 'pending' = 'done'): Promise<number> {
  const { job, tools } = openJob();
  await approve(tools);
  service.store.plans.setStepStatus(job.id, 'builder-1', stepStatus);
  service.store.applyJobEvent(job.id, { type: 'cancel' }, 'test');
  service.store.finishClose(job.id, 'cleanup done');
  return job.id;
}

const lessonCards = (): AgencyQuestion[] =>
  service.store
    .listQuestions(REPO.repoId, { statuses: ['open'] })
    .filter((q) => q.kind === 'crew_lesson');

const projectBuilder = (): string =>
  join(projectCrewDir(REPO.repoId, join(dir, 'home')), 'roles', 'builder.md');

describe('the review after a job', () => {
  it('puts a lesson the record supports up as a card on the Bridge', async () => {
    answers = [lessonAnswer()];
    const jobId = await endedJob();
    await service.lessons.review(jobId);
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toContain('<<<role: builder>>>');
    expect(calls[0].user).toContain('<<<record>>>');
    const [card] = lessonCards();
    expect(card).toMatchObject({
      jobId: null,
      question: 'Teach the builder role?',
      options: [{ label: 'This project' }, { label: 'All projects' }, { label: 'Not now' }],
      lesson: { jobId, role: 'builder', source: 'bundled', replace: LESSON.replace }
    });
    expect(card.context).toContain(LESSON.evidence);
  });

  it('puts nothing up when the model finds no lesson', async () => {
    await service.lessons.review(await endedJob());
    expect(calls).toHaveLength(1);
    expect(lessonCards()).toEqual([]);
  });

  it('sends a refused lesson back once with the reason', async () => {
    answers = [lessonAnswer({ replace: 'Not in the role.' }), lessonAnswer()];
    await service.lessons.review(await endedJob());
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('It was refused: "replace" must be text of the builder role');
    expect(lessonCards()).toHaveLength(1);
  });

  it('drops a lesson refused twice', async () => {
    answers = [lessonAnswer({ replace: 'Nope.' }), lessonAnswer({ replace: 'Nope.' })];
    await service.lessons.review(await endedJob());
    expect(calls).toHaveLength(2);
    expect(lessonCards()).toEqual([]);
  });

  it('skips a job whose crew never started, and a job reviewed already', async () => {
    await service.lessons.review(await endedJob('pending'));
    expect(calls).toEqual([]);
    const jobId = await endedJob();
    await service.lessons.review(jobId);
    await service.lessons.review(jobId);
    expect(calls).toHaveLength(1);
  });

  it('skips the model while a lesson card is open', async () => {
    answers = [lessonAnswer()];
    await service.lessons.review(await endedJob());
    await service.lessons.review(await endedJob());
    expect(calls).toHaveLength(1);
  });

  it('runs when cleanup ends a job', async () => {
    answers = [lessonAnswer()];
    const { job, tools } = openJob();
    await approve(tools);
    service.store.plans.setStepStatus(job.id, 'builder-1', 'done');
    expect(service.closeJob({ jobId: job.id, action: 'cancel' }).ok).toBe(true);
    await vi.waitFor(() => expect(lessonCards()).toHaveLength(1));
  });
});

describe('answering a lesson card', () => {
  async function card(): Promise<AgencyQuestion> {
    answers = [lessonAnswer()];
    await service.lessons.review(await endedJob());
    const [q] = lessonCards();
    return q;
  }

  it("This project saves the project's copy and leaves the bundled role alone", async () => {
    const bundled = readFileSync(BUNDLED_BUILDER, 'utf8');
    const q = await card();
    expect((await service.answerClient({ id: q.id, option: 0 }))?.status).toBe('answered');
    expect(readFileSync(projectBuilder(), 'utf8')).toContain(LESSON.with);
    expect(readFileSync(BUNDLED_BUILDER, 'utf8')).toBe(bundled);
    const role = (await service.crewCatalog(REPO.repoId)).roles.find((r) => r.name === 'builder');
    expect(role).toMatchObject({ source: 'project', runtime: 'claude' });
  });

  it("All projects saves the user's own copy", async () => {
    const q = await card();
    await service.answerClient({ id: q.id, option: 1 });
    expect(readFileSync(join(dir, 'user-crew', 'roles', 'builder.md'), 'utf8')).toContain(
      LESSON.with
    );
    expect(existsSync(projectBuilder())).toBe(false);
  });

  it('Not now writes nothing and the lesson is not proposed again', async () => {
    const q = await card();
    await service.answerClient({ id: q.id, option: 2 });
    expect(existsSync(projectBuilder())).toBe(false);
    expect(
      service.store.preferences.topicDeclined(REPO.repoId, lessonTopic('builder', LESSON.cue))
    ).toBe(true);
    answers = [lessonAnswer(), lessonAnswer()];
    await service.lessons.review(await endedJob());
    expect(calls.at(-2)?.user).toContain('when the project has a lint step');
    expect(lessonCards()).toEqual([]);
  });

  it('refuses an answer without one of its options', async () => {
    const q = await card();
    expect(await service.answerClient({ id: q.id, text: 'Sure.' })).toBeNull();
    expect(lessonCards()).toHaveLength(1);
  });

  it('refuses the answer when the role no longer has the replaced text', async () => {
    const q = await card();
    const builder = (await service.crewCatalog(REPO.repoId)).roles.find(
      (r) => r.name === 'builder'
    );
    if (builder === undefined) throw new Error('no builder');
    const draft = {
      name: 'builder',
      description: builder.description,
      runtime: builder.runtime,
      stack: builder.stack,
      instructions: builder.prompt
    };
    const saved = await service.saveCrewRole({
      repoId: REPO.repoId,
      base: draft,
      role: { ...draft, instructions: 'You are a Builder. Ship it.' }
    });
    expect(saved.ok).toBe(true);
    expect(await service.answerClient({ id: q.id, option: 1 })).toBeNull();
    expect(lessonCards()).toHaveLength(1);
  });
});
