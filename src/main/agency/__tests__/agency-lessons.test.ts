import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lessonTopic } from '../../../shared/agency-lessons';
import type { PlanInput } from '../../../shared/agency-plan';
import { projectCrewDir } from '../crew/catalog';
import { AgencyService } from '../index';
import type { AdmiralCompletion } from '../understanding';
import { factsGit, fakeGh, REPO } from './fixture';
import { planHelpers } from './plan-helpers';

/** Crew lessons: the review after a job, the lesson it writes, and Undo. */

const SHIPPED_CREW = fileURLToPath(new URL('../../../../resources/crew', import.meta.url));
const BUNDLED_BUILDER = join(SHIPPED_CREW, 'roles', 'builder.md');

const LESSON: {
  role: string;
  cue: string;
  lesson: string;
  evidence: string;
  replace: string | null;
  with: string;
} = {
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

const { openJob, startPlan } = planHelpers(() => service, PLAN);

/** A job whose builder step ran, ended by the client's cancel. */
async function endedJob(stepStatus: 'done' | 'pending' = 'done'): Promise<number> {
  const { job, tools } = openJob();
  await startPlan(tools);
  service.store.plans.setStepStatus(job.id, 'builder-1', stepStatus);
  service.store.applyJobEvent(job.id, { type: 'cancel' }, 'test');
  service.store.finishClose(job.id, 'cleanup done');
  return job.id;
}

const projectBuilder = (): string =>
  join(projectCrewDir(REPO.repoId, join(dir, 'home')), 'roles', 'builder.md');

const lessons = () => service.lessons.list(REPO.repoId);

async function builderRole() {
  const role = (await service.crewCatalog(REPO.repoId)).roles.find((r) => r.name === 'builder');
  if (role === undefined) throw new Error('no builder');
  return role;
}

/** The project's builder saved from Settings with these instructions. */
async function editBuilder(instructions: string): Promise<void> {
  const builder = await builderRole();
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
    role: { ...draft, instructions }
  });
  expect(saved.ok).toBe(true);
}

describe('the review after a job', () => {
  it("writes a lesson the record supports into the project's copy of the role", async () => {
    const bundled = readFileSync(BUNDLED_BUILDER, 'utf8');
    answers = [lessonAnswer()];
    const jobId = await endedJob();
    await service.lessons.review(jobId);
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toContain('<<<role: builder>>>');
    expect(calls[0].user).toContain('<<<record>>>');
    expect(readFileSync(projectBuilder(), 'utf8')).toContain(LESSON.with);
    expect(readFileSync(BUNDLED_BUILDER, 'utf8')).toBe(bundled);
    expect(await builderRole()).toMatchObject({ source: 'project', runtime: 'claude' });
    expect(lessons()).toMatchObject([
      { jobId, role: 'builder', replace: LESSON.replace, with: LESSON.with, undoneAt: null }
    ]);
    expect(service.store.listQuestions(REPO.repoId, { statuses: ['open'] })).toEqual([]);
  });

  it('writes nothing when the model finds no lesson', async () => {
    await service.lessons.review(await endedJob());
    expect(calls).toHaveLength(1);
    expect(existsSync(projectBuilder())).toBe(false);
    expect(lessons()).toEqual([]);
  });

  it('sends a refused lesson back once with the reason', async () => {
    answers = [lessonAnswer({ replace: 'Not in the role.' }), lessonAnswer()];
    await service.lessons.review(await endedJob());
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('It was refused: "replace" must be text of the builder role');
    expect(lessons()).toHaveLength(1);
  });

  it('drops a lesson refused twice', async () => {
    answers = [lessonAnswer({ replace: 'Nope.' }), lessonAnswer({ replace: 'Nope.' })];
    await service.lessons.review(await endedJob());
    expect(calls).toHaveLength(2);
    expect(lessons()).toEqual([]);
  });

  it('skips a job whose crew never started, and a job reviewed already', async () => {
    await service.lessons.review(await endedJob('pending'));
    expect(calls).toEqual([]);
    const jobId = await endedJob();
    await service.lessons.review(jobId);
    await service.lessons.review(jobId);
    expect(calls).toHaveLength(1);
  });

  it('runs when cleanup ends a job', async () => {
    answers = [lessonAnswer()];
    const { job, tools } = openJob();
    await startPlan(tools);
    service.store.plans.setStepStatus(job.id, 'builder-1', 'done');
    expect(service.closeJob({ jobId: job.id, action: 'cancel' }).ok).toBe(true);
    await vi.waitFor(() => expect(lessons()).toHaveLength(1));
  });
});

describe('undoing a lesson', () => {
  async function learned(): Promise<number> {
    answers = [lessonAnswer()];
    await service.lessons.review(await endedJob());
    const [lesson] = lessons();
    return lesson.id;
  }

  it('puts the old text back, and the lesson is not learned again', async () => {
    const id = await learned();
    expect(await service.lessons.undo(id)).toEqual({ ok: true });
    const role = readFileSync(projectBuilder(), 'utf8');
    expect(role).toContain(LESSON.replace);
    expect(role).not.toContain(LESSON.with);
    expect(lessons()[0].undoneAt).not.toBeNull();
    expect(
      service.store.preferences.topicDeclined(REPO.repoId, lessonTopic('builder', LESSON.cue))
    ).toBe(true);

    answers = [lessonAnswer(), lessonAnswer()];
    await service.lessons.review(await endedJob());
    expect(calls.at(-2)?.user).toContain('when the project has a lint step');
    expect(lessons()).toHaveLength(1);
  });

  it('takes out a lesson that added a paragraph', async () => {
    answers = [lessonAnswer({ replace: null, with: 'Run lint before you finish.' })];
    await service.lessons.review(await endedJob());
    const before = (await builderRole()).prompt;
    expect(await service.lessons.undo(lessons()[0].id)).toEqual({ ok: true });
    const after = (await builderRole()).prompt;
    expect(before).toContain('Run lint before you finish.');
    expect(after).not.toContain('Run lint before you finish.');
  });

  it('refuses once the client changed that part of the role', async () => {
    const id = await learned();
    await editBuilder('You are a Builder. Ship it.');
    expect(await service.lessons.undo(id)).toEqual({
      ok: false,
      reason: 'The builder role changed there since. Edit it in Settings instead.'
    });
    expect(lessons()[0].undoneAt).toBeNull();
  });

  it('refuses a second undo', async () => {
    const id = await learned();
    await service.lessons.undo(id);
    expect(await service.lessons.undo(id)).toMatchObject({ ok: false });
  });
});
