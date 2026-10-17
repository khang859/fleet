import {
  jobDisplayId,
  RUNNING_JOB_STATES,
  type AgencyJob,
  type JobState
} from '../../../shared/agency';
import {
  DEFAULT_CREW_LIMIT,
  NO_PLAN_CHECKS,
  type AgencyJobDetail,
  type AgencyPlanVersion,
  type AgencyStep,
  type PlanAction,
  type PlanActionResult,
  type PlanBases,
  type PlanChecks,
  type PlanEffects,
  type StepStatus
} from '../../../shared/agency-jobs';
import { PlanSchema, diffPlans, validatePlanGraph, type Plan } from '../../../shared/agency-plan';
import { createLogger } from '../../logger';
import {
  canDecide,
  lockedViolations,
  missingDeliverables,
  planEffects,
  stepsToRemove
} from '../plans/plan-rules';
import { checkPlan, pinBases, type PlanFacts } from '../plans/plan-checks';
import type { OtherJobPaths } from '../plans/overlap';
import type { AgencyStore, AgencyTouched } from '../store/agency-store';
import { CREW_ENDED } from '../store/crew-store';
import type { PlanVersionRecord } from '../store/plan-store';
import { acceptsPlans } from './job-machine';
import { canStartStep, type StartVerdict } from './start-gate';

const log = createLogger('agency:jobs');

/** A job another one queues behind holds it until it delivers or ends. */
const UNDER_WAY: readonly JobState[] = ['planned', 'running', 'waiting', 'interrupted'];

/**
 * How Fleet stops a crew member's pane. The crew phase wires the real panes;
 * until then nothing is ever hired, so there is nothing to stop.
 */
export type CrewControl = {
  stop(paneId: string): Promise<void>;
  /** Panes that are still running, for the startup reconcile. */
  livePanes(): ReadonlySet<string>;
};

export const NO_CREW: CrewControl = {
  stop: async () => Promise.resolve(),
  livePanes: () => new Set()
};

export type ProposeResult = { ok: true; version: PlanVersionRecord } | { ok: false; error: string };

/** What the Admiral may set a step to with `job_update`. Removal is a plan change. */
export type StepUpdate = { step: string; status?: 'running' | 'blocked' | 'done'; note?: string };

export type JobsServiceDeps = {
  store: AgencyStore;
  crew: CrewControl;
  /** Raise a change event for what a write touched. */
  changed: (touched: AgencyTouched[]) => void;
  /**
   * What the pre-approval check reads about the job's project, given the
   * paths other running jobs touch and the bases already pinned. Without it
   * (tests of other parts) a plan has nothing to report and no bases.
   */
  planFacts?: (input: {
    job: AgencyJob;
    plan: Plan;
    others: OtherJobPaths[];
    pinned: PlanBases | null;
  }) => Promise<PlanFacts>;
  /** Crew members that may work at once, per job and across every job. */
  crewLimit?: () => number;
};

/**
 * A job's plan and steps: proposing a version, the client's approve, edit and
 * reject, and the Admiral's step updates. Every write goes through the job
 * state machine, and nothing here starts work: approval only says which steps
 * may start, and starting asks `canStartStep`.
 */
export class JobsService {
  constructor(private readonly deps: JobsServiceDeps) {}

  private get store(): AgencyStore {
    return this.deps.store;
  }

  /**
   * Put a plan version up for the client and return at once. Earlier versions
   * still waiting are replaced, so only the newest can be approved.
   */
  async propose(
    jobId: number,
    plan: Plan,
    author: 'admiral' | 'client' = 'admiral'
  ): Promise<ProposeResult> {
    const job = this.store.getJob(jobId);
    if (!job) return { ok: false, error: `There is no job ${jobDisplayId(jobId)}.` };
    const refused = this.refusePlan(job, plan);
    if (refused !== null) return { ok: false, error: refused };
    const checks = await this.check(job, plan);

    const version = this.store.tx(() => {
      const approved = this.store.plans.approved(jobId);
      this.store.plans.replacePending(jobId);
      const inserted = this.store.plans.insertVersion({
        jobId,
        kind: approved === null ? 'initial' : 'change',
        author,
        parentVersion: approved?.version ?? null,
        plan,
        checks
      });
      this.store.applyJobEvent(jobId, { type: 'plan_proposed' }, `plan v${inserted.version}`);
      this.store.plans.log({
        jobId,
        kind: 'plan',
        text: `Plan v${inserted.version} proposed by the ${author === 'client' ? 'client' : 'Admiral'}`
      });
      return inserted;
    });
    this.deps.changed([{ repoId: job.repoId, jobId }]);
    return { ok: true, version };
  }

  /** Run the pre-approval check against the project as it is now. */
  private async check(job: AgencyJob, plan: Plan): Promise<PlanChecks> {
    if (!this.deps.planFacts) return NO_PLAN_CHECKS;
    const facts = await this.deps.planFacts({
      job,
      plan,
      others: this.otherJobPaths(job),
      pinned: this.store.plans.approved(job.id)?.bases ?? null
    });
    return checkPlan(plan, facts);
  }

  /** The paths each live step of the project's other running jobs expects to touch. */
  private otherJobPaths(job: AgencyJob): OtherJobPaths[] {
    return this.store
      .listJobs(job.repoId)
      .filter((j) => j.id !== job.id && RUNNING_JOB_STATES.includes(j.state))
      .flatMap((other) => {
        const plan = this.store.plans.approved(other.id)?.plan;
        if (!plan) return [];
        const live = new Set(
          this.store.plans
            .steps(other.id)
            .filter((s) => s.status !== 'done' && s.status !== 'removed')
            .map((s) => s.id)
        );
        const steps = plan.steps
          .filter((s) => live.has(s.id) && s.paths.length > 0)
          .map((s) => ({ step: s.id, paths: s.paths }));
        return steps.length === 0 ? [] : [{ jobId: other.id, steps }];
      });
  }

  /** The plan the job runs now, or null before one is approved. */
  approvedPlan(jobId: number): Plan | null {
    return this.store.plans.approved(jobId)?.plan ?? null;
  }

  /** Why `plan` cannot be proposed for `job` right now, or null when it can. */
  private refusePlan(job: AgencyJob, plan: Plan): string | null {
    if (!acceptsPlans(job.state)) {
      return `${jobDisplayId(job.id)} is ${job.state} and takes no new plan.`;
    }
    const problems = [
      ...validatePlanGraph(plan),
      ...lockedViolations({
        approved: this.store.plans.approved(job.id)?.plan ?? null,
        next: plan,
        steps: this.store.plans.steps(job.id),
        delivered: this.store.plans.resultsByStep(job.id),
        spendUsd: this.store.plans.spendUsd(job.id)
      })
    ];
    return problems.length === 0 ? null : problems.join(' ');
  }

  /** The client's approve, edit or reject on a plan card. */
  async decide(action: PlanAction): Promise<PlanActionResult> {
    const version = this.store.plans.version(action.planVersionId);
    const verdict = canDecide(
      version,
      version === null ? null : this.store.plans.newest(version.jobId)
    );
    if (!verdict.ok || version === null) {
      return verdict.ok ? { ok: false, reason: 'There is no such plan version.' } : verdict;
    }
    const job = this.store.getJob(version.jobId);
    if (!job || !acceptsPlans(job.state)) {
      return { ok: false, reason: `${jobDisplayId(version.jobId)} takes no plan decisions now.` };
    }
    switch (action.action) {
      case 'approve':
        return this.approve(job, version, action.baseChoice ?? {}, action.swaps ?? {});
      case 'reject':
        return this.reject(job, version, action.note);
      case 'edit': {
        const parsed = PlanSchema.safeParse(action.plan);
        if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? '' };
        const result = await this.propose(job.id, parsed.data, 'client');
        if (!result.ok) return { ok: false, reason: result.error };
        this.store.tx(() => {
          this.store.resetChain(job.id);
          this.store.enqueueWakeup({
            repoId: job.repoId,
            jobId: job.id,
            kind: 'client_action',
            payload: {
              line: `Client edited plan v${version.version} into v${result.version.version}`,
              note: null
            }
          });
        });
        this.deps.changed([{ repoId: job.repoId, jobId: job.id }]);
        return { ok: true, version: result.version.version };
      }
    }
  }

  private async approve(
    job: AgencyJob,
    version: PlanVersionRecord,
    baseChoice: Record<string, 'default' | 'head'>,
    swapChoice: Record<string, 'continue' | 'restart'>
  ): Promise<PlanActionResult> {
    const gate = await this.approvable(job, version, baseChoice);
    if (!gate.ok) return gate;
    const { checks, bases } = gate;

    const effects = this.store.tx(() => {
      const approved = this.store.plans.approved(job.id);
      const steps = this.store.plans.steps(job.id);
      const preview = this.effectsOf(job, version.plan, approved?.plan ?? null);
      const swaps = Object.fromEntries(
        preview.swaps.map((s) => [s.stepId, swapChoice[s.stepId] ?? 'continue'] as const)
      );
      this.store.plans.supersede(job.id);
      this.store.plans.decide(version.id, 'approved');
      if (checks.bases.length > 0) this.store.plans.setBases(version.id, bases);
      this.store.setApprovedVersion(job.id, version.version, version.plan.budget.usd);
      version.plan.steps.forEach((step, position) => {
        this.store.plans.putStep({
          jobId: job.id,
          stepId: step.id,
          role: step.role,
          position,
          version: version.version
        });
      });
      const withdrawn: number[] = [];
      for (const stepId of stepsToRemove(steps, version.plan)) {
        this.store.plans.setStepStatus(job.id, stepId, 'removed', version.version);
        withdrawn.push(
          ...this.store.withdrawForStep({ jobId: job.id, step: stepId, reason: 'step removed' })
        );
      }
      this.store.plans.setEffects(version.id, {
        stopCrewIds: preview.stopCrew.map((c) => c.crewId),
        withdrawnQuestionIds: withdrawn,
        swaps
      });
      this.store.applyJobEvent(
        job.id,
        { type: 'plan_approved' },
        `plan v${version.version} approved`
      );
      this.store.resetChain(job.id);
      this.store.enqueueWakeup({
        repoId: job.repoId,
        jobId: job.id,
        kind: 'client_action',
        payload: { line: `Client approved plan v${version.version}`, note: swapNote(swaps) }
      });
      this.store.plans.log({
        jobId: job.id,
        kind: 'decision',
        text: `Plan v${version.version} approved`
      });
      return preview;
    });
    this.refreshClientHold(job.id);
    this.deps.changed([{ repoId: job.repoId, jobId: job.id }]);
    // Removed and swapped steps stop after the approval is on record, so a
    // restart in between replays it from the stored effects.
    void this.stopCrew(
      effects.stopCrew.map((c) => c.crewId),
      `plan v${version.version}`
    );
    return { ok: true, version: version.version };
  }

  /**
   * Checks a plan again just before approval, since a step may have finished,
   * gh signed out or a branch appeared since the card went up, and pins the
   * commits its crew start from.
   */
  private async approvable(
    job: AgencyJob,
    version: PlanVersionRecord,
    baseChoice: Record<string, 'default' | 'head'>
  ): Promise<{ ok: false; reason: string } | { ok: true; checks: PlanChecks; bases: PlanBases }> {
    const refused = this.refusePlan(job, version.plan);
    if (refused !== null) return { ok: false, reason: refused };
    const checks = await this.check(job, version.plan);
    this.store.plans.setChecks(version.id, checks);
    const blocked = checks.issues.filter((i) => i.severity === 'block');
    if (blocked.length > 0) {
      this.deps.changed([{ repoId: job.repoId, jobId: job.id }]);
      return { ok: false, reason: blocked.map((i) => i.text).join(' ') };
    }
    const pin = pinBases(checks.bases, baseChoice);
    if (!pin.ok) return { ok: false, reason: pin.reason };
    // Another click may have decided it, or a newer version replaced it, while the check ran.
    const verdict = canDecide(
      this.store.plans.version(version.id),
      this.store.plans.newest(job.id)
    );
    if (!verdict.ok) return verdict;
    return { ok: true, checks, bases: pin.bases };
  }

  private reject(job: AgencyJob, version: PlanVersionRecord, note: string): PlanActionResult {
    this.store.tx(() => {
      this.store.plans.decide(version.id, 'rejected', note);
      if (job.approvedVersion === null) {
        this.store.applyJobEvent(
          job.id,
          { type: 'plan_rejected' },
          `plan v${version.version} rejected`
        );
      }
      this.store.resetChain(job.id);
      this.store.enqueueWakeup({
        repoId: job.repoId,
        jobId: job.id,
        kind: 'client_action',
        payload: { line: `Client rejected plan v${version.version}`, note }
      });
      this.store.plans.log({
        jobId: job.id,
        kind: 'decision',
        text: `Plan v${version.version} rejected`
      });
    });
    this.deps.changed([{ repoId: job.repoId, jobId: job.id }]);
    return { ok: true, version: version.version };
  }

  /** Stop crew members by id, then mark them ended. A failure is logged and the rest go on. */
  /**
   * At launch: stop the crew an approved plan change stopped, where a quit
   * came between recording the approval and stopping them.
   */
  async replayStops(): Promise<void> {
    for (const job of this.store.jobsIn(UNDER_WAY)) {
      const approved = this.store.plans.approved(job.id);
      if (approved === null) continue;
      const live = (approved.effects?.stopCrewIds ?? []).filter(
        (id) => this.store.crew.get(id)?.status !== CREW_ENDED
      );
      if (live.length > 0) await this.stopCrew(live, `plan v${approved.version}`);
    }
  }

  async stopCrew(ids: number[], reason: string): Promise<void> {
    for (const id of ids) {
      const crew = this.store.crew.get(id);
      if (!crew || crew.status === 'ended') continue;
      try {
        if (crew.paneId !== null) await this.deps.crew.stop(crew.paneId);
        this.store.crew.end(id, reason);
      } catch (err) {
        log.warn('could not stop a crew member', { id, error: String(err) });
      }
    }
    this.admitQueued();
  }

  private effectsOf(job: AgencyJob, next: Plan, approved: Plan | null): PlanEffects {
    return planEffects({
      approved,
      next,
      steps: this.store.plans.steps(job.id),
      liveCrew: this.store.crew.live(job.id),
      questions: this.store.listQuestions(job.repoId, { jobId: job.id }),
      delivered: this.store.plans.resultsByStep(job.id),
      spendUsd: this.store.plans.spendUsd(job.id)
    });
  }

  /**
   * The Admiral's step update: start, block or finish a step of the approved
   * plan, and add a progress note. Returns a sentence for the model either
   * way. Finishing a step withdraws its open questions and may deliver the job.
   */
  updateStep(jobId: number, update: StepUpdate): { ok: boolean; text: string } {
    const job = this.store.getJob(jobId);
    const approved = this.store.plans.approved(jobId);
    if (!job || approved === null) {
      return { ok: false, text: 'There is no approved plan yet; propose one with job_plan.' };
    }
    const step = this.store.plans.step(jobId, update.step);
    if (!step || step.status === 'removed') {
      return { ok: false, text: `Step ${update.step} is not in the approved plan.` };
    }
    if (update.status === 'running' && job.state === 'delivered') {
      this.store.applyJobEvent(jobId, { type: 'follow_up' }, `follow-up on ${update.step}`);
    }
    const current = this.store.getJob(jobId) ?? job;
    const target = this.targetStatus(current, approved.plan, step, update);
    if (!target.ok) return target;

    this.writeStepUpdate(current, update, target.status);
    if (target.queued !== null) {
      return {
        ok: true,
        text: `Step ${update.step} is queued: ${target.queued} A wakeup tells you when it can start.`
      };
    }
    const state = this.store.getJob(jobId)?.state ?? current.state;
    const moved = update.status === undefined ? 'noted' : `is ${update.status}`;
    return { ok: true, text: `Step ${update.step} ${moved}. ${jobDisplayId(jobId)} is ${state}.` };
  }

  /**
   * The status an update moves a step to: what the Admiral asked, or
   * `queued` when starting it now would go over the crew limit or ahead of
   * the job it queues behind. Refused when it may not start at all, or the
   * job's steps do not move in its state.
   */
  private targetStatus(
    job: AgencyJob,
    plan: Plan,
    step: AgencyStep,
    update: StepUpdate
  ):
    | { ok: false; text: string }
    | { ok: true; status: StepStatus | undefined; queued: string | null } {
    const start =
      update.status === 'running' && step.status !== 'running'
        ? this.startVerdict(job, plan, update.step)
        : null;
    if (start?.ok === false && start.queue !== true) return { ok: false, text: start.reason };
    if (update.status !== undefined && !['running', 'waiting', 'delivered'].includes(job.state)) {
      return { ok: false, text: `${jobDisplayId(job.id)} is ${job.state}; its steps do not move.` };
    }
    const queued = start?.ok === false ? start.reason : null;
    return { ok: true, status: queued === null ? update.status : 'queued', queued };
  }

  private writeStepUpdate(
    job: AgencyJob,
    update: StepUpdate,
    status: StepStatus | undefined
  ): void {
    this.store.tx(() => {
      if (status !== undefined) this.moveStep(job, update.step, status);
      if (update.note !== undefined) {
        this.store.plans.setStepNote(job.id, update.step, update.note);
        this.store.plans.log({
          jobId: job.id,
          kind: 'note',
          stepId: update.step,
          text: update.note
        });
      }
    });
    this.refreshClientHold(job.id);
    this.afterStepChange(job.id);
    this.deps.changed([{ repoId: job.repoId, jobId: job.id }]);
    if (status === 'done') this.admitQueued();
  }

  /** Whether a step may start now, with the crew limit and the job it queues behind. */
  private startVerdict(job: AgencyJob, plan: Plan, stepId: string, admitted = 0): StartVerdict {
    const behind = plan.queueBehind === null ? null : this.store.getJob(plan.queueBehind);
    return canStartStep({
      job,
      plan,
      steps: this.store.plans.steps(job.id),
      stepId,
      queuedBehind: behind && UNDER_WAY.includes(behind.state) ? behind.id : null,
      live: {
        job: this.store.crew.live(job.id).length + admitted,
        all: this.store.crew.live().length + admitted,
        limit: this.deps.crewLimit?.() ?? DEFAULT_CREW_LIMIT
      }
    });
  }

  /**
   * Let queued steps go as places free up, longest waiting first: each one
   * goes back to not started, and its job's Admiral gets a wakeup to start
   * it. Run when a step finishes, a job delivers or ends, or crew stop.
   */
  admitQueued(): void {
    const touched: AgencyTouched[] = [];
    let admitted = 0;
    for (const { jobId, stepId } of this.store.plans.queuedSteps()) {
      const job = this.store.getJob(jobId);
      const plan = this.store.plans.approved(jobId)?.plan;
      if (!job || !plan || !this.startVerdict(job, plan, stepId, admitted).ok) continue;
      admitted += 1;
      this.store.tx(() => {
        this.store.plans.setStepStatus(jobId, stepId, 'pending');
        this.store.plans.log({ jobId, kind: 'step', stepId, text: `Step ${stepId} may start` });
        this.store.enqueueWakeup({
          repoId: job.repoId,
          jobId,
          kind: 'event',
          payload: { line: `Step ${stepId} can start now`, body: null }
        });
      });
      touched.push({ repoId: job.repoId, jobId });
    }
    if (touched.length > 0) this.deps.changed(touched);
  }

  private moveStep(job: AgencyJob, stepId: string, status: StepStatus): void {
    this.store.plans.setStepStatus(job.id, stepId, status);
    this.store.plans.log({ jobId: job.id, kind: 'step', stepId, text: `Step ${stepId} ${status}` });
    if (status === 'done') {
      this.store.withdrawForStep({ jobId: job.id, step: stepId, reason: 'step finished' });
      this.store.resetChain(job.id);
    }
  }

  /** A running job whose every live step is done and delivered what it listed is delivered. */
  afterStepChange(jobId: number): void {
    const job = this.store.getJob(jobId);
    const approved = this.store.plans.approved(jobId);
    if (job?.state !== 'running' || approved === null) return;
    const steps = this.store.plans.steps(jobId).filter((s) => s.status !== 'removed');
    if (steps.length === 0 || steps.some((s) => s.status !== 'done')) return;
    if (
      missingDeliverables(approved.plan, steps, this.store.plans.resultsByStep(jobId)).length > 0
    ) {
      return;
    }
    this.store.applyJobEvent(jobId, { type: 'delivered' }, 'every step is done and delivered');
  }

  /**
   * Hold a running job on the client while every step not done waits on one
   * of their open questions, and let it go once one does not.
   */
  refreshClientHold(jobId: number): void {
    const job = this.store.getJob(jobId);
    if (job?.approvedVersion == null) return;
    const live = this.store.plans
      .steps(jobId)
      .filter((s) => s.status !== 'done' && s.status !== 'removed');
    const asked = new Set(
      this.store
        .listQuestions(job.repoId, { jobId, statuses: ['open'] })
        .flatMap((q) => (q.step === null ? [] : [q.step]))
    );
    const waiting = live.length > 0 && live.every((s) => asked.has(s.id));
    if (waiting === job.holds.includes('client')) return;
    if (waiting) this.store.addHold(jobId, 'client');
    else this.store.releaseHold(jobId, 'client');
  }

  /** The step a question may be tied to must be in the plan the job runs or proposes. */
  questionPlan(jobId: number, step: string | null): { planVersion: number | null; error?: string } {
    const plan = this.store.plans.approved(jobId) ?? this.store.plans.pending(jobId);
    if (step === null) return { planVersion: plan?.version ?? null };
    if (!plan?.plan.steps.some((s) => s.id === step)) {
      return { planVersion: null, error: `Step ${step} is not in the plan.` };
    }
    return { planVersion: plan.version };
  }

  /** Everything the job sheet and the plan cards show for one job. */
  detail(jobId: number): AgencyJobDetail | null {
    const job = this.store.getJob(jobId);
    if (!job) return null;
    const records = this.store.plans.versions(jobId);
    const approved = records.find((v) => v.status === 'approved')?.plan ?? null;
    const versions = records.map((v): AgencyPlanVersion => {
      const parent = records.find((p) => p.version === v.parentVersion)?.plan ?? null;
      return {
        id: v.id,
        jobId: v.jobId,
        version: v.version,
        status: v.status,
        kind: v.kind,
        author: v.author,
        parentVersion: v.parentVersion,
        plan: v.plan,
        checks: v.checks,
        bases: v.bases,
        decisionNote: v.decisionNote,
        proposedAt: v.proposedAt,
        decidedAt: v.decidedAt,
        diff: diffPlans(parent, v.plan),
        effects:
          v.status === 'proposed' && v.kind === 'change'
            ? this.effectsOf(job, v.plan, approved)
            : null
      };
    });
    return {
      job,
      versions,
      steps: this.store.plans.steps(jobId),
      events: this.store.jobEvents(jobId),
      log: this.store.plans.logTail(jobId),
      spendUsd: this.store.plans.spendUsd(jobId)
    };
  }
}

function swapNote(swaps: Record<string, 'continue' | 'restart'>): string | null {
  const lines = Object.entries(swaps).map(
    ([step, choice]) =>
      `${step}: ${choice === 'continue' ? 'continue its work in the same workspace' : 'start over on a new branch'}`
  );
  return lines.length === 0 ? null : `Swaps: ${lines.join('; ')}.`;
}
