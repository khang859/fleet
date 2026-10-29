import { join } from 'node:path';
import { TERMINAL_JOB_STATES } from '../../../shared/agency';
import type { CrewCatalog } from '../../../shared/agency-crew';
import {
  lessonTopic,
  undoLesson,
  type AppliedCrewLesson,
  type CrewLessonUndo,
  type LessonAnswer
} from '../../../shared/agency-lessons';
import { createLogger } from '../../logger';
import { maskCredentials } from '../../redactor';
import { writeRole } from '../crew/catalog';
import type { SpendService } from '../spend/spend-service';
import type { AgencyStore } from '../store/agency-store';
import type { AdmiralCompletion } from '../understanding';
import {
  LESSON_MAX_TOKENS,
  LESSON_SYSTEM_PROMPT,
  lessonRequest,
  retryRequest,
  reviewOutcome,
  type CheckedLesson,
  type RanRole
} from './review';

const log = createLogger('agency:lessons');

/** Steps whose crew never started teach nothing about their role. */
const NOT_RUN = new Set(['pending', 'queued', 'removed']);

/** How many times the model may answer: once, and once more with the reason it was refused. */
const ATTEMPTS = 2;

const TOPIC_PREFIX = 'crew-lesson:';

export type CrewLessonsDeps = {
  store: Pick<AgencyStore, 'getJob' | 'plans' | 'preferences' | 'lessons'>;
  spend: Pick<SpendService, 'reserveAdmiralCall' | 'admiralCallDone'>;
  /** Unset, there is no model to review with. */
  complete: AdmiralCompletion | null;
  /** The job's record as Markdown, with env file values masked, or null for a job still open. */
  record: (jobId: number) => Promise<string | null>;
  catalog: (repoId: string) => Promise<CrewCatalog>;
  /** A project's crew folder. */
  projectCrew: (repoId: string) => string;
  changed: (repoId: string) => void;
};

/**
 * Crew lessons: after a job that ran crew ends, one review on the Admiral's
 * model finds at most one change to a role, and Fleet writes it at once to
 * the project's copy of the role. A bundled or user role is never changed.
 * Each lesson is recorded, so the client can undo it.
 */
export class CrewLessons {
  /** Jobs reviewed this run, so a second close does not review again. */
  private readonly reviewed = new Set<number>();

  constructor(private readonly deps: CrewLessonsDeps) {}

  /** Review an ended job and write a lesson into its role, if there is one to keep. */
  async review(jobId: number): Promise<void> {
    if (this.reviewed.has(jobId)) return;
    this.reviewed.add(jobId);
    const { store, complete } = this.deps;
    const job = store.getJob(jobId);
    if (job === null || !TERMINAL_JOB_STATES.includes(job.state) || complete === null) return;
    const ran = this.ranRoles(jobId);
    if (ran.size === 0) return;
    const record = await this.deps.record(jobId);
    if (record === null) return;
    const catalog = await this.deps.catalog(job.repoId);
    const declined = store.preferences.declinedTopics(job.repoId, TOPIC_PREFIX);
    const roles = [...ran.values()].map((r): RanRole => {
      const now = catalog.roles.find((c) => c.name === r.name)?.prompt ?? null;
      return { name: r.name, ran: r.prompt, now: now === null || now === r.prompt ? null : now };
    });
    const request = maskCredentials(
      lessonRequest({
        roles,
        declined: declined.map((t) => t.slice(TOPIC_PREFIX.length)),
        record
      })
    );
    const checks = {
      ran: [...ran.keys()],
      roles: catalog.roles,
      declined: (topic: string) => store.preferences.topicDeclined(job.repoId, topic)
    };
    let user = request;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const text = await this.ask(complete, user);
      if (text === null) return;
      const outcome = reviewOutcome(text, checks);
      if (outcome.kind === 'none') {
        log.info('no lesson from the job', { jobId });
        return;
      }
      if (outcome.kind === 'keep') {
        await this.write(job.repoId, jobId, outcome.lesson, outcome.checked);
        return;
      }
      log.info('lesson refused', { jobId, attempt, reason: outcome.reason });
      user = retryRequest(request, text, outcome.reason);
    }
  }

  /** One completion inside the monthly cap, or null when it may not run or failed. */
  private async ask(complete: AdmiralCompletion, user: string): Promise<string | null> {
    const gate = this.deps.spend.reserveAdmiralCall();
    if (!gate.ok) {
      log.info('lesson review skipped', { why: gate.text });
      return null;
    }
    try {
      const out = await complete({
        system: LESSON_SYSTEM_PROMPT,
        user,
        maxTokens: LESSON_MAX_TOKENS
      });
      this.deps.spend.admiralCallDone(gate.reservationId, out.costUsd);
      return out.text;
    } catch (err) {
      this.deps.spend.admiralCallDone(gate.reservationId, null);
      log.warn('lesson review failed', { err: String(err) });
      return null;
    }
  }

  /** The roles the job's crew ran with, by name, as the approved plan's snapshot has them. */
  private ranRoles(jobId: number): Map<string, { name: string; prompt: string }> {
    const crew = this.deps.store.plans.approved(jobId)?.crew ?? null;
    const used = new Set(
      this.deps.store.plans
        .steps(jobId)
        .filter((s) => !NOT_RUN.has(s.status))
        .map((s) => s.role)
    );
    return new Map(
      (crew?.roles ?? []).filter((r) => used.has(r.name)).map((r) => [r.name, r] as const)
    );
  }

  /** Write the lesson into the project's copy of the role, and record it for Undo. */
  private async write(
    repoId: string,
    jobId: number,
    lesson: LessonAnswer,
    { role, instructions }: CheckedLesson
  ): Promise<void> {
    const createdCopy = role.source !== 'project';
    const path = createdCopy
      ? join(this.deps.projectCrew(repoId), 'roles', `${role.name}.md`)
      : role.path;
    try {
      await writeRole(path, role, instructions);
    } catch (err) {
      log.warn('lesson not written', { jobId, err: String(err) });
      return;
    }
    this.deps.store.lessons.record({
      projectId: repoId,
      jobId,
      role: role.name,
      cue: lesson.cue,
      lesson: lesson.lesson,
      replace: lesson.replace,
      with: lesson.with,
      path,
      createdCopy
    });
    this.deps.changed(repoId);
  }

  /** The lessons written into a project's roles, newest first. */
  list(repoId: string): AppliedCrewLesson[] {
    return this.deps.store.lessons.list(repoId).map((l) => ({
      id: l.id,
      jobId: l.jobId,
      role: l.role,
      cue: l.cue,
      lesson: l.lesson,
      replace: l.replace,
      with: l.with,
      appliedAt: l.appliedAt,
      undoneAt: l.undoneAt
    }));
  }

  /**
   * Take a lesson out of its role again, and remember it so the same lesson
   * is not learned again. Refused when the client changed that part since.
   */
  async undo(id: number): Promise<CrewLessonUndo> {
    const { store } = this.deps;
    const lesson = store.lessons.get(id);
    if (lesson?.undoneAt !== null) {
      return { ok: false, reason: 'That lesson is undone already.' };
    }
    const role = (await this.deps.catalog(lesson.projectId)).roles.find(
      (r) => r.name === lesson.role && r.path === lesson.path
    );
    const instructions = role === undefined ? null : undoLesson(role.prompt, lesson);
    if (role === undefined || instructions === null) {
      return {
        ok: false,
        reason: `The ${lesson.role} role changed there since. Edit it in Settings instead.`
      };
    }
    try {
      await writeRole(lesson.path, role, instructions);
    } catch (err) {
      log.warn('lesson not undone', { id, err: String(err) });
      return { ok: false, reason: 'The role file could not be written.' };
    }
    store.lessons.markUndone(id);
    store.preferences.declineTopic(lesson.projectId, lessonTopic(lesson.role, lesson.cue));
    this.deps.changed(lesson.projectId);
    return { ok: true };
  }
}
