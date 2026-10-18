import {
  jobDisplayId,
  RUNNING_JOB_STATES,
  type AgencyJob,
  type JobState
} from '../../../shared/agency';
import {
  ACCEPTS_RESULTS,
  NO_PLAN_CHECKS,
  type AgencyCrewMember,
  type AgencyJobDetail,
  type AgencyMergeRun,
  type AgencyPlanVersion,
  type AgencyServer,
  type AgencyStep,
  type PlanAction,
  type PlanActionResult,
  type PlanBases,
  type PlanChecks,
  type PlanEffects,
  type PlanUse,
  type StepStatus,
  type StepSwapRequest
} from '../../../shared/agency-jobs';
import { YOU_LAYER } from '../../../shared/agency-client-file';
import { TRUST_NAME, type AutoStartRule } from '../../../shared/agency-projects';
import { jsonEqual } from '../../../shared/json-equal';
import {
  PlanSchema,
  diffPlans,
  newRoleProblems,
  planStepList,
  scopeProblems,
  validatePlanGraph,
  type Plan
} from '../../../shared/agency-plan';
import {
  defaultAtOnce,
  type CrewReportStatus,
  type CrewRuntime,
  type CrewSnapshot
} from '../../../shared/agency-crew';
import { budgetProblem, NO_JOB_SPEND, type JobSpend } from '../../../shared/agency-spend';
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
import { CREW_ENDED, CREW_LIVE, crewRuntime, type CrewRecord } from '../store/crew-store';
import type { PlanVersionRecord } from '../store/plan-store';
import { acceptsPlans } from './job-machine';
import type { StackSlots } from './stack-slots';
import { canStartStep, type StartVerdict } from './start-gate';

const log = createLogger('agency:jobs');

/** What the Admiral does next with a crew member's report. */
function reportBody(status: CrewReportStatus, deliver: string[]): string {
  switch (status) {
    case 'done':
      return [
        deliver.length > 0
          ? `It delivered ${deliver.join(', ')}: record each with job_deliver.`
          : 'Record what the step delivered with job_deliver.',
        'Stop it with crew_stop once you need nothing more from it; it holds a crew place until then.'
      ].join(' ');
    case 'blocked':
      return 'Unblock it with crew_send, ask the client with ask_client, or propose a plan change.';
    case 'question':
      return 'Answer it with crew_send, or ask the client with ask_client when the decision is theirs.';
  }
}

/** A job another one queues behind holds it until it delivers or ends. */
const UNDER_WAY: readonly JobState[] = ['planned', 'running', 'waiting', 'interrupted'];

/** Closes the wakeup for a client plan edit or reject, so the Admiral weighs it beyond this job. */
const LEARN_HINT =
  'Consider whether this is a lasting preference. If it is, and no line in your note says it, offer to remember it with `client_file_propose`.';

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

export type ProposeResult =
  | {
      ok: true;
      version: PlanVersionRecord;
      /** Ids in the plan's `uses` that name no saved line, left out. */
      dropped: string[];
      /** Fleet approved it on its own, under the project's trust level. */
      autoStarted: boolean;
    }
  | { ok: false; error: string };

/** Whether a plan is small enough to start without the client, before the pre-approval checks. */
export function autoStartable(version: PlanVersionRecord, rule: AutoStartRule): boolean {
  const { plan } = version;
  return (
    version.kind === 'initial' &&
    version.author === 'admiral' &&
    plan.newRoles.length === 0 &&
    plan.budget.usd <= rule.usd &&
    (plan.budget.weekPct ?? 0) <= rule.weekPct
  );
}

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
  /** Crew of a runtime that may work at once, across every job; `defaultAtOnce` unless set. */
  crewLimit?: (runtime: CrewRuntime) => number;
  /**
   * The roles and playbook a plan uses, as their files say now, kept with the
   * approval so the job runs on them. Without it the approval keeps no crew.
   */
  crewSnapshot?: (job: AgencyJob, plan: Plan) => Promise<CrewSnapshot>;
  /**
   * Save the roles a plan brings in the project's crew folder, on its
   * approval and before its crew is snapshotted. Without it they are not saved.
   */
  saveRoles?: (job: AgencyJob, plan: Plan) => Promise<{ saved: string[] } | { refused: string }>;
  /** The project's stack slots; without it, steps that run the stack wait on none. */
  stack?: Pick<StackSlots, 'gate' | 'runsStack'>;
  /** The servers a job's crew started, for its sheet; none unless set. */
  servers?: (jobId: number) => AgencyServer[];
  /** What a job spent against its budgets, for its sheet; nothing unless set. */
  spend?: (job: AgencyJob) => JobSpend;
  /** Why Claude crew wait for the user's subscription reserve now; none unless set. */
  claudeReserve?: () => string | null;
  /** The monthly cap no job budget may pass; none unless set. */
  monthlyCapUsd?: () => number;
  /** The share of the weekly Claude limit a plan that names none gets; none unless set. */
  defaultWeekPct?: () => number;
  /** The project's saved preference lines by their note id, for a plan's `uses`; none unless set. */
  preferenceLines?: (repoId: string) => PlanUse[];
  /** When the project lets Fleet start a plan on its own; never unless set. */
  autoStart?: (repoId: string) => AutoStartRule | null;
  /** A job just delivered everything; nothing happens unless set. */
  delivered?: (jobId: number) => void;
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
    const share = this.deps.defaultWeekPct?.();
    if (plan.budget.weekPct === undefined && share !== undefined) {
      plan = { ...plan, budget: { ...plan.budget, weekPct: share } };
    }
    const refused = this.refusePlan(job, plan);
    if (refused !== null) return { ok: false, error: refused };
    const { uses, dropped } = this.resolveUses(job.repoId, plan.uses);
    plan = { ...plan, uses: uses.map((u) => u.id) };
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
        checks,
        uses
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
    const autoStarted = await this.autoStart(job, version);
    return {
      ok: true,
      version: this.store.plans.version(version.id) ?? version,
      dropped,
      autoStarted
    };
  }

  /** The saved lines a plan's `uses` names, and the ids that name none. */
  private resolveUses(repoId: string, ids: string[]): { uses: PlanUse[]; dropped: string[] } {
    const lines = new Map((this.deps.preferenceLines?.(repoId) ?? []).map((l) => [l.id, l]));
    const wanted = [...new Set(ids.map((id) => id.toUpperCase()))];
    return {
      uses: wanted.flatMap((id) => lines.get(id) ?? []),
      dropped: wanted.filter((id) => !lines.has(id))
    };
  }

  /**
   * Approve a first plan without a card when the project's trust level lets
   * Fleet: it must be small enough and pass the same checks the client's
   * Approve runs, with nothing for the client to tick. False leaves the card.
   */
  private async autoStart(job: AgencyJob, version: PlanVersionRecord): Promise<boolean> {
    const rule = this.deps.autoStart?.(job.repoId) ?? null;
    if (rule === null || !autoStartable(version, rule)) return false;
    const current = this.store.getJob(job.id) ?? job;
    const result = await this.approve(
      current,
      version,
      { planVersionId: version.id, action: 'approve' },
      rule
    );
    return result.ok;
  }

  /**
   * The client raised a job's budget on its raise-or-stop card: the approved
   * plan with the new budget becomes a new approved version, with the same
   * steps, bases and crew. A change still waiting is replaced, as it was
   * measured against the old budget. Returns the new version, or null
   * without an approved plan.
   */
  raiseBudget(jobId: number, budget: Plan['budget']): number | null {
    const job = this.store.getJob(jobId);
    if (!job) return null;
    const version = this.store.tx(() => {
      const approved = this.store.plans.approved(jobId);
      if (approved === null) return null;
      this.store.plans.replacePending(jobId);
      const inserted = this.store.plans.insertVersion({
        jobId,
        kind: 'change',
        author: 'client',
        parentVersion: approved.version,
        plan: { ...approved.plan, budget },
        checks: approved.checks,
        uses: approved.uses
      });
      this.store.plans.supersede(jobId);
      this.store.plans.decide(inserted.id, 'approved');
      if (approved.bases !== null) this.store.plans.setBases(inserted.id, approved.bases);
      if (approved.crew !== null) this.store.plans.setCrew(inserted.id, approved.crew);
      this.store.setApprovedVersion(jobId, inserted.version, budget);
      this.store.plans.log({
        jobId,
        kind: 'plan',
        text: `Plan v${inserted.version}: the client raised the budget`
      });
      return inserted.version;
    });
    this.deps.changed([{ repoId: job.repoId, jobId }]);
    return version;
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
      ...scopeProblems(plan.steps),
      ...newRoleProblems(plan),
      ...lockedViolations({
        approved: this.store.plans.approved(job.id)?.plan ?? null,
        next: plan,
        steps: this.store.plans.steps(job.id),
        delivered: this.store.plans.resultsByStep(job.id),
        spent: this.store.spend.jobTotals(job.id)
      }),
      ...budgetProblems(plan, this.deps.monthlyCapUsd?.() ?? null)
    ];
    return problems.length === 0 ? null : problems.join(' ');
  }

  /** The client's approve, edit or reject on a plan card. */
  async decide(action: PlanAction): Promise<PlanActionResult> {
    const version = this.store.plans.version(action.planVersionId);
    if (action.action === 'edit' && version !== null && this.changesStarted(version)) {
      return this.editStarted(version, action.plan);
    }
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
        return this.approve(job, version, action);
      case 'reject':
        return this.reject(job, version, action.note);
      case 'edit': {
        const parsed = PlanSchema.safeParse(action.plan);
        if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? '' };
        return this.proposeForClient(
          job,
          parsed.data,
          version.plan,
          (v) => `Client edited plan v${version.version} into v${v}`
        );
      }
    }
  }

  /** A plan Fleet started on its own that is still the newest, which the client may change. */
  private changesStarted(version: PlanVersionRecord): boolean {
    return (
      version.autoStartUsd !== null &&
      version.status === 'approved' &&
      this.store.plans.newest(version.jobId)?.id === version.id
    );
  }

  /** Change on a plan Fleet started on its own: the client's edit, as a plan change card. */
  private async editStarted(version: PlanVersionRecord, input: unknown): Promise<PlanActionResult> {
    const job = this.store.getJob(version.jobId);
    if (!job || !acceptsPlans(job.state)) {
      return { ok: false, reason: `${jobDisplayId(version.jobId)} takes no plan changes now.` };
    }
    const parsed = PlanSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? '' };
    return this.proposeForClient(
      job,
      parsed.data,
      version.plan,
      (v) => `Client changed plan v${version.version}, which started on its own, into v${v}`
    );
  }

  /**
   * Swap on a crew card: the approved plan with a running step's role, runtime
   * or model changed, as the client's plan change card. Refused while another
   * version waits, so the client decides on that one first.
   */
  async swapStep(swap: StepSwapRequest): Promise<PlanActionResult> {
    const job = this.store.getJob(swap.jobId);
    const approved = this.store.plans.approved(swap.jobId);
    const step = approved?.plan.steps.find((s) => s.id === swap.stepId);
    if (!job || !approved || !step) {
      return { ok: false, reason: `Step ${swap.stepId} is not in the approved plan.` };
    }
    const newest = this.store.plans.newest(job.id);
    if (newest?.status === 'proposed') {
      return {
        ok: false,
        reason: `Plan v${newest.version} is waiting for you. Approve or reject it first.`,
        newestVersion: newest.version
      };
    }
    const swapped = {
      ...step,
      role: swap.role,
      runtime: swap.runtime ?? undefined,
      model: swap.model ?? undefined
    };
    if (jsonEqual(swapped, step)) return { ok: false, reason: 'The step runs that way now.' };
    const plan = {
      ...approved.plan,
      steps: approved.plan.steps.map((s) => (s.id === step.id ? swapped : s))
    };
    return this.proposeForClient(
      job,
      plan,
      approved.plan,
      (v) => `Client swapped step ${step.id} on a crew card, as plan v${v}`
    );
  }

  /**
   * A plan version from the client, which wakes the Admiral with `line` and
   * the steps before and after, so it can ask whether to remember the change.
   */
  private async proposeForClient(
    job: AgencyJob,
    plan: Plan,
    before: Plan,
    line: (version: number) => string
  ): Promise<PlanActionResult> {
    const result = await this.propose(job.id, plan, 'client');
    if (!result.ok) return { ok: false, reason: result.error };
    this.store.tx(() => {
      this.store.resetChain(job.id);
      this.store.enqueueWakeup({
        repoId: job.repoId,
        jobId: job.id,
        kind: 'client_action',
        payload: {
          line: line(result.version.version),
          note: null,
          detail: `Before: ${planStepList(before)}\nAfter: ${planStepList(plan)}\n${LEARN_HINT}`
        }
      });
    });
    this.deps.changed([{ repoId: job.repoId, jobId: job.id }]);
    return { ok: true, version: result.version.version };
  }

  /** Approve a plan version: the client's Approve, or Fleet's under `rule`. */
  private async approve(
    job: AgencyJob,
    version: PlanVersionRecord,
    action: Extract<PlanAction, { action: 'approve' }>,
    rule: AutoStartRule | null = null
  ): Promise<PlanActionResult> {
    const swapChoice = action.swaps ?? {};
    const gate = await this.approvable(job, version, action);
    if (!gate.ok) return gate;
    const { checks, bases } = gate;
    const hired = await this.approvedCrew(job, version.plan);
    if (!hired.ok) return hired;
    const { crew, saved } = hired;

    const effects = this.store.tx(() => {
      const approved = this.store.plans.approved(job.id);
      const steps = this.store.plans.steps(job.id);
      const preview = this.effectsOf(job, version.plan, approved?.plan ?? null);
      const swaps = Object.fromEntries(
        preview.swaps.map((s) => [s.stepId, swapChoice[s.stepId] ?? 'continue'] as const)
      );
      this.store.plans.supersede(job.id);
      this.store.plans.decide(version.id, 'approved');
      if (rule !== null) this.store.plans.markAutoStarted(version.id, rule.usd);
      for (const use of version.uses) {
        this.store.preferences.recordUse(
          use.layer === 'you' ? YOU_LAYER : job.repoId,
          use.text,
          job.id
        );
      }
      if (checks.bases.length > 0) this.store.plans.setBases(version.id, bases);
      if (crew !== null) this.store.plans.setCrew(version.id, crew);
      this.store.setApprovedVersion(job.id, version.version, version.plan.budget);
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
      // Fleet's own approval answers the Admiral's job_plan call, so no wakeup says it again.
      if (rule === null) {
        this.store.enqueueWakeup({
          repoId: job.repoId,
          jobId: job.id,
          kind: 'client_action',
          payload: { line: `Client approved plan v${version.version}`, note: swapNote(swaps) }
        });
      }
      this.store.plans.log({
        jobId: job.id,
        kind: 'decision',
        text:
          rule === null
            ? `Plan v${version.version} approved`
            : `Plan v${version.version} started on its own: ${TRUST_NAME[rule.level]}, within $${rule.usd}`
      });
      for (const name of saved) {
        this.store.plans.log({
          jobId: job.id,
          kind: 'decision',
          text: `Saved the role ${name} in the project's crew`
        });
      }
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
   * Saves the plan's new roles in the project's crew, then snapshots the
   * roles the plan uses, so the job runs on the files as they are now.
   */
  private async approvedCrew(
    job: AgencyJob,
    plan: Plan
  ): Promise<
    { ok: false; reason: string } | { ok: true; crew: CrewSnapshot | null; saved: string[] }
  > {
    const roles =
      plan.newRoles.length === 0 ? null : ((await this.deps.saveRoles?.(job, plan)) ?? null);
    if (roles !== null && 'refused' in roles) return { ok: false, reason: roles.refused };
    const crew = (await this.deps.crewSnapshot?.(job, plan)) ?? null;
    // A role file can go between the check and here; the job must not start without it.
    const lost = plan.steps.find((s) => crew && !crew.roles.some((r) => r.name === s.role));
    if (lost) return { ok: false, reason: `The role ${lost.role} is gone. Check the plan again.` };
    return { ok: true, crew, saved: roles?.saved ?? [] };
  }

  /**
   * Checks a plan again just before approval, since a step may have finished,
   * gh signed out or a branch appeared since the card went up, and pins the
   * commits its crew start from.
   */
  private async approvable(
    job: AgencyJob,
    version: PlanVersionRecord,
    { baseChoice = {}, acceptCost = false }: Extract<PlanAction, { action: 'approve' }>
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
    if (!acceptCost && checks.issues.some((i) => i.severity === 'accept')) {
      this.deps.changed([{ repoId: job.repoId, jobId: job.id }]);
      return {
        ok: false,
        reason: 'Accept the steps whose cost Fleet cannot measure on the plan card first.'
      };
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
        payload: { line: `Client rejected plan v${version.version}`, note, detail: LEARN_HINT }
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
      spendUsd: this.store.spend.jobTotals(job.id).usd
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

    this.writeStepUpdate(current, update, target.status, target.queued);
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
    if (update.status !== undefined && !ACCEPTS_RESULTS.includes(job.state)) {
      return { ok: false, text: `${jobDisplayId(job.id)} is ${job.state}; its steps do not move.` };
    }
    const queued = start?.ok === false ? start.reason : null;
    return { ok: true, status: queued === null ? update.status : 'queued', queued };
  }

  /** Move the step and keep the Admiral's note, or why the step is queued. */
  private writeStepUpdate(
    job: AgencyJob,
    update: StepUpdate,
    status: StepStatus | undefined,
    queued: string | null
  ): void {
    this.store.tx(() => {
      if (status !== undefined) this.moveStep(job, update.step, status);
      if (queued !== null && update.note === undefined) {
        this.store.plans.setStepNote(job.id, update.step, queued);
      }
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

  /** Whether a step of the job's approved plan may be hired for now. */
  startCheck(jobId: number, stepId: string): StartVerdict {
    const job = this.store.getJob(jobId);
    const plan = this.store.plans.approved(jobId)?.plan ?? null;
    if (!job || plan === null) {
      return { ok: false, reason: 'There is no approved plan yet; propose one with job_plan.' };
    }
    return this.startVerdict(job, plan, stepId);
  }

  /**
   * A hire moves its step: `running` as its crew member starts, `queued`
   * while it waits for a place, or back to where it was when the hire failed.
   */
  hireMoved(jobId: number, stepId: string, status: StepStatus, note?: string): void {
    const job = this.store.getJob(jobId);
    if (!job) return;
    this.store.tx(() => {
      this.moveStep(job, stepId, status);
      if (note !== undefined) this.store.plans.setStepNote(jobId, stepId, note);
    });
    this.refreshClientHold(jobId);
    this.deps.changed([{ repoId: job.repoId, jobId }]);
  }

  /**
   * A crew member left its step before the step was done: the client closed
   * its pane (`stopped`) or its runtime ended (`failed`). The step waits for
   * the client's OK to hire again, and the Admiral hears of it.
   */
  crewLeft(input: {
    jobId: number;
    stepId: string;
    status: 'stopped' | 'failed';
    label: string;
    note: string;
  }): void {
    const { jobId, stepId } = input;
    const job = this.store.getJob(jobId);
    if (!job || this.store.plans.step(jobId, stepId)?.status !== 'running') {
      // The step moved on before its member left, but the member's place is free now.
      this.admitQueued();
      return;
    }
    const what = input.status === 'stopped' ? 'was stopped' : 'failed';
    this.store.tx(() => {
      this.moveStep(job, stepId, input.status);
      this.store.plans.setStepNote(jobId, stepId, input.note);
      this.store.askQuestion({
        repoId: job.repoId,
        jobId,
        kind: 'rehire',
        step: stepId,
        planVersion: job.approvedVersion,
        question: `Step ${stepId} ${what} before it was done`,
        context: `${input.label} ${input.note}. Its pane is closed; its worktree and branch stay as it left them.`,
        options: [
          { label: 'Hire again', detail: 'the Admiral hires a new crew member for the step' },
          { label: 'Leave it', detail: 'the step stays stopped until you say more' }
        ],
        recommended: null
      });
      this.store.resetChain(jobId);
      this.store.enqueueWakeup({
        repoId: job.repoId,
        jobId,
        kind: 'event',
        payload: {
          line: `Step ${stepId} ${what}: ${input.label} ${input.note}`,
          body: 'Fleet asked the client whether to hire for it again; their answer arrives as a wakeup. Until then the step does not start.'
        }
      });
    });
    this.refreshClientHold(jobId);
    this.deps.changed([{ repoId: job.repoId, jobId }]);
    this.admitQueued();
  }

  /**
   * A crew member reported its step with `fleet agency done`: `done` finishes
   * the step, `blocked` blocks it, and a `question` leaves it running. The
   * summary becomes the step's note, and the Admiral wakes to it.
   */
  crewReported(input: {
    jobId: number;
    stepId: string;
    label: string;
    status: CrewReportStatus;
    summary: string;
    deliver: string[];
  }): void {
    const { jobId, stepId, label, status, summary, deliver } = input;
    const job = this.store.getJob(jobId);
    const step = this.store.plans.step(jobId, stepId);
    if (!job || !ACCEPTS_RESULTS.includes(job.state)) {
      throw new Error(`Not reported: ${jobDisplayId(jobId)} is ${job?.state ?? 'gone'}.`);
    }
    if (step?.status !== 'running' && step?.status !== 'blocked') {
      throw new Error(`Not reported: step ${stepId} is ${step?.status ?? 'not in the plan'}.`);
    }
    this.store.tx(() => {
      if (status !== 'question') this.moveStep(job, stepId, status);
      this.store.plans.setStepNote(jobId, stepId, summary);
      this.store.plans.log({
        jobId,
        kind: 'crew',
        stepId,
        text: `${label} reported ${status}: ${summary}`,
        data: { status, deliver }
      });
      this.store.enqueueWakeup({
        repoId: job.repoId,
        jobId,
        kind: 'event',
        payload: {
          line: `${label} reported step ${stepId} ${status}: ${summary}`,
          body: reportBody(status, deliver)
        }
      });
    });
    this.refreshClientHold(jobId);
    this.afterStepChange(jobId);
    this.deps.changed([{ repoId: job.repoId, jobId }]);
    if (status === 'done') this.admitQueued();
  }

  /**
   * A crew member ended a turn without reporting. The Admiral wakes to answer
   * or nudge it, until it has been idle more times than the nudge limit
   * allows: then a running step is blocked.
   */
  crewIdle(input: {
    jobId: number;
    stepId: string;
    label: string;
    idle: number;
    nudgeLimit: number;
  }): void {
    const { jobId, stepId, label, idle, nudgeLimit } = input;
    const job = this.store.getJob(jobId);
    if (!job || !ACCEPTS_RESULTS.includes(job.state)) return;
    const running = this.store.plans.step(jobId, stepId)?.status === 'running';
    const blocks = running && idle > nudgeLimit;
    const left = nudgeLimit - idle + 1;
    const turns = idle === 1 ? 'a turn' : `${idle} turns in a row`;
    this.store.tx(() => {
      if (blocks) {
        this.moveStep(job, stepId, 'blocked');
        this.store.plans.setStepNote(jobId, stepId, `${label} ended ${turns} without reporting`);
      }
      this.store.enqueueWakeup({
        repoId: job.repoId,
        jobId,
        kind: 'event',
        payload: blocks
          ? {
              line: `Step ${stepId} is blocked: ${label} ended ${turns} without reporting`,
              body: "Read its last message with fleet_read. Ask the client what to do with ask_client, or propose a plan change. Prompting it again needs a higher nudge limit, which is the client's call."
            }
          : {
              line: `${label} ended ${turns} on step ${stepId} without reporting`,
              body: running
                ? `Read its last message with fleet_read. Answer its question, or nudge it to finish and report, with crew_send. ${left === 1 ? 'This is its last prompt' : `It has ${left} prompts left`} before the step is blocked.`
                : 'Read its last message with fleet_read.'
            }
      });
    });
    if (blocks) this.refreshClientHold(jobId);
    this.deps.changed([{ repoId: job.repoId, jobId }]);
  }

  /**
   * Something happened to a crew member that the Admiral should hear of, such
   * as a new crew flag: it goes in the job record, and the Admiral wakes to it.
   */
  crewNotice(input: { jobId: number; stepId: string; line: string; body: string }): void {
    const { jobId, stepId, line, body } = input;
    const job = this.store.getJob(jobId);
    if (!job || !ACCEPTS_RESULTS.includes(job.state)) return;
    this.store.tx(() => {
      this.store.plans.log({ jobId, kind: 'crew', stepId, text: line });
      this.store.enqueueWakeup({
        repoId: job.repoId,
        jobId,
        kind: 'event',
        payload: { line, body }
      });
    });
    this.deps.changed([{ repoId: job.repoId, jobId }]);
  }

  /** The runtime a step's crew run on: the step's, else its role's in the approved crew. */
  private stepRuntime(jobId: number, plan: Plan, stepId: string): CrewRuntime {
    const step = plan.steps.find((s) => s.id === stepId);
    const role = this.store.plans.approved(jobId)?.crew?.roles.find((r) => r.name === step?.role);
    return step?.runtime ?? role?.runtime ?? 'claude';
  }

  /**
   * Whether a step may start now, with its runtime's crew limit, the job it
   * queues behind and the stack slots. `admitted` counts steps let go but not
   * hired yet.
   */
  private startVerdict(
    job: AgencyJob,
    plan: Plan,
    stepId: string,
    admitted: { crew: Partial<Record<CrewRuntime, number>>; stack: number } = {
      crew: {},
      stack: 0
    }
  ): StartVerdict {
    const behind = plan.queueBehind === null ? null : this.store.getJob(plan.queueBehind);
    const runtime = this.stepRuntime(job.id, plan, stepId);
    return canStartStep({
      job,
      plan,
      steps: this.store.plans.steps(job.id),
      stepId,
      queuedBehind: behind && UNDER_WAY.includes(behind.state) ? behind.id : null,
      live: {
        runtime,
        working:
          this.store.crew.live().filter((c) => crewRuntime(c) === runtime).length +
          (admitted.crew[runtime] ?? 0),
        limit: this.deps.crewLimit?.(runtime) ?? defaultAtOnce(runtime, false)
      },
      stack: this.deps.stack?.gate(job, stepId, admitted.stack),
      reserve: runtime === 'claude' ? (this.deps.claudeReserve?.() ?? null) : null
    });
  }

  /**
   * Let queued steps go as places free up, longest waiting first: each one
   * goes back to not started, and its job's Admiral gets a wakeup to start
   * it. Run when a step finishes, a job delivers or ends, or crew stop.
   */
  admitQueued(): void {
    const touched: AgencyTouched[] = [];
    const crew: Partial<Record<CrewRuntime, number>> = {};
    const stack = new Map<string, number>();
    for (const { jobId, stepId } of this.store.plans.queuedSteps()) {
      const job = this.store.getJob(jobId);
      const plan = this.store.plans.approved(jobId)?.plan;
      const admitted = { crew, stack: job ? (stack.get(job.repoId) ?? 0) : 0 };
      if (!job || !plan || !this.startVerdict(job, plan, stepId, admitted).ok) continue;
      const runtime = this.stepRuntime(jobId, plan, stepId);
      crew[runtime] = (crew[runtime] ?? 0) + 1;
      if (this.deps.stack?.runsStack(jobId, stepId)) stack.set(job.repoId, admitted.stack + 1);
      this.store.tx(() => {
        this.store.plans.setStepStatus(jobId, stepId, 'pending');
        this.store.plans.setStepNote(jobId, stepId, '');
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
    this.deps.delivered?.(jobId);
  }

  /**
   * Hold a running job on the client while every step not done waits on one
   * of their open questions or permission cards, and let it go once one does not.
   */
  refreshClientHold(jobId: number): void {
    const job = this.store.getJob(jobId);
    if (job?.approvedVersion == null) return;
    const live = this.store.plans
      .steps(jobId)
      .filter((s) => s.status !== 'done' && s.status !== 'removed');
    const asked = new Set([
      ...this.store
        .listQuestions(job.repoId, { jobId, statuses: ['open'] })
        .flatMap((q) => (q.step === null ? [] : [q.step])),
      ...this.store.permissions
        .open()
        .filter((p) => p.jobId === jobId && p.state !== 'admiral')
        .map((p) => p.stepId)
    ]);
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
            : null,
        uses: v.uses,
        autoStartUsd: v.autoStartUsd
      };
    });
    return {
      job,
      versions,
      steps: this.store.plans.steps(jobId),
      events: this.store.jobEvents(jobId),
      log: this.store.plans.logTail(jobId),
      results: this.store.results.forJob(jobId),
      spend: this.deps.spend?.(job) ?? NO_JOB_SPEND,
      merge: mergeView(this.store.merges.run(jobId)),
      crew: this.store.crew.all(jobId).map(crewView),
      servers: this.deps.servers?.(jobId) ?? [],
      permissions: this.store.permissions.forJob(jobId)
    };
  }
}

/** A plan's budgets as the client could type them: positive, a share at most 100%, dollars within the cap. */
function budgetProblems(plan: Plan, monthlyCapUsd: number | null): string[] {
  const { usd, weekPct } = plan.budget;
  return [
    budgetProblem(usd, 'usd', monthlyCapUsd),
    weekPct === undefined ? null : budgetProblem(weekPct, 'week_pct', null)
  ].filter((p): p is string => p !== null);
}

const crewView = (c: CrewRecord): AgencyCrewMember => ({
  id: c.id,
  stepId: c.stepId,
  role: c.role,
  runtime: c.runtime === 'eva' ? 'eva' : 'claude',
  model: c.model,
  label: c.label,
  paneId: c.paneId,
  status: c.status === CREW_ENDED ? 'ended' : c.status === CREW_LIVE ? 'live' : 'starting',
  flag: c.flag,
  flagUntil: c.flagUntil,
  startedAt: c.startedAt,
  endedAt: c.endedAt,
  endReason: c.endReason
});

const mergeView = (run: AgencyMergeRun | null): AgencyMergeRun | null =>
  run === null ? null : { status: run.status, note: run.note };

function swapNote(swaps: Record<string, 'continue' | 'restart'>): string | null {
  const lines = Object.entries(swaps).map(
    ([step, choice]) =>
      `${step}: ${choice === 'continue' ? 'continue its work in the same workspace' : 'start over on a new branch'}`
  );
  return lines.length === 0
    ? null
    : `Swaps: ${lines.join('; ')}. Hire each swapped step again once its old member has stopped.`;
}
