import { join } from 'node:path';
import {
  jobDisplayId,
  TERMINAL_JOB_STATES,
  type AgencyAnswerRequest,
  type AgencyQuestion
} from '../../../shared/agency';
import type { CrewCatalog, CrewRole } from '../../../shared/agency-crew';
import {
  applyLesson,
  lessonOptions,
  lessonPick,
  lessonTopic,
  type CrewLesson
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
  store: Pick<AgencyStore, 'getJob' | 'plans' | 'listQuestions' | 'askQuestion' | 'preferences'>;
  spend: Pick<SpendService, 'reserveAdmiralCall' | 'admiralCallDone'>;
  /** Unset, there is no model to review with. */
  complete: AdmiralCompletion | null;
  /** The job's record as Markdown, with env file values masked, or null for a job still open. */
  record: (jobId: number) => Promise<string | null>;
  catalog: (repoId: string) => Promise<CrewCatalog>;
  /** The user's crew folder, and a project's. */
  userCrew: string | null;
  projectCrew: (repoId: string) => string;
  changed: (repoId: string) => void;
};

/**
 * Crew lessons: after a job that ran crew ends, one review on the Admiral's
 * model proposes at most one change to a role, as a card on the Bridge.
 * Nothing is written until the client approves, and a bundled role is never
 * changed: approving saves the project's or the user's copy.
 */
export class CrewLessons {
  /** Jobs reviewed this run, so a second close does not review again. */
  private readonly reviewed = new Set<number>();

  constructor(private readonly deps: CrewLessonsDeps) {}

  /** Review an ended job and put a lesson up as a card, if there is one to keep. */
  async review(jobId: number): Promise<void> {
    if (this.reviewed.has(jobId)) return;
    this.reviewed.add(jobId);
    const { store, complete } = this.deps;
    const job = store.getJob(jobId);
    if (job === null || !TERMINAL_JOB_STATES.includes(job.state) || complete === null) return;
    const ran = this.ranRoles(jobId);
    if (ran.size === 0) return;
    if (this.openCard(job.repoId) !== undefined) {
      log.info('a lesson card is open already; no review', { jobId });
      return;
    }
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
        this.propose(job.repoId, jobId, outcome.lesson, outcome.checked);
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

  private openCard(repoId: string): AgencyQuestion | undefined {
    return this.deps.store
      .listQuestions(repoId, { statuses: ['open'] })
      .find((q) => q.kind === 'crew_lesson');
  }

  private propose(
    repoId: string,
    jobId: number,
    answer: Omit<CrewLesson, 'jobId' | 'source'>,
    { role }: CheckedLesson
  ): void {
    const lesson: CrewLesson = { ...answer, jobId, source: role.source };
    this.deps.store.askQuestion({
      repoId,
      jobId: null,
      kind: 'crew_lesson',
      question: `Teach the ${role.name} role?`,
      context: `${lesson.lesson}\n\n**When:** ${lesson.cue}. **Seen on ${jobDisplayId(jobId)}:** ${lesson.evidence}`,
      options: lessonOptions(role.source).map(({ label, detail }) => ({ label, detail })),
      recommended: 0,
      lesson
    });
    this.deps.changed(repoId);
  }

  /**
   * Write what the client picked on a lesson card, before the answer is
   * recorded. The role is read again, so a lesson applies to its text now;
   * false refuses the answer when it picks no option, when the text it
   * replaces is gone, or when the file cannot be written. Not now remembers the lesson as turned down.
   */
  async apply(q: AgencyQuestion, req: AgencyAnswerRequest): Promise<boolean> {
    const { lesson } = q;
    if (q.kind !== 'crew_lesson' || q.status !== 'open' || lesson === null) return true;
    const pick = lessonPick(lesson, req.option);
    if (pick === null) return false;
    if (pick === 'decline') {
      this.deps.store.preferences.declineTopic(q.repoId, lessonTopic(lesson.role, lesson.cue));
      return true;
    }
    const role = (await this.deps.catalog(q.repoId)).roles.find((r) => r.name === lesson.role);
    const instructions = role === undefined ? null : applyLesson(role.prompt, lesson);
    if (role === undefined || instructions === null) {
      log.warn('lesson no longer applies', { question: q.id, role: lesson.role });
      return false;
    }
    const path = this.target(pick, role, q.repoId);
    if (path === null) return false;
    try {
      await writeRole(path, role, instructions);
    } catch (err) {
      log.warn('lesson not written', { question: q.id, err: String(err) });
      return false;
    }
    return true;
  }

  /** The file a pick writes: the role's own file when it is already there, else a new copy. */
  private target(pick: 'own' | 'project' | 'user', role: CrewRole, repoId: string): string | null {
    const source = pick === 'user' ? 'user' : 'project';
    if (role.source === source) return role.path;
    const dir = source === 'user' ? this.deps.userCrew : this.deps.projectCrew(repoId);
    return dir === null ? null : join(dir, 'roles', `${role.name}.md`);
  }
}
