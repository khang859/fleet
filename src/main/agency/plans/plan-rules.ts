import type { AgencyQuestion } from '../../../shared/agency';
import type { AgencyStep, PlanEffects, StepSwap } from '../../../shared/agency-jobs';
import type { Plan } from '../../../shared/agency-plan';
import { jsonEqual } from '../../../shared/json-equal';
import type { CrewRecord } from '../store/crew-store';
import type { PlanVersionRecord } from '../store/plan-store';

/**
 * The rules a plan version is held to, as pure functions over what the store
 * read: what a change may not touch, what approving it does, and what still
 * has to be delivered.
 */

type Delivered = { stepId: string | null; kind: string; label: string };

const SWAP_FIELDS = ['role', 'runtime', 'model'] as const;

/**
 * What a new version may not do to the approved one: change or drop a step
 * that is done or already delivered something, or set the budget below what
 * was spent. One sentence each; empty when the version is fine.
 */
export function lockedViolations(input: {
  approved: Plan | null;
  next: Plan;
  steps: AgencyStep[];
  delivered: Delivered[];
  spendUsd: number;
}): string[] {
  const problems: string[] = [];
  if (input.next.budget.usd < input.spendUsd) {
    problems.push(
      `The budget cannot go below what the job already spent ($${input.spendUsd.toFixed(2)}).`
    );
  }
  if (input.approved === null) return problems;
  const next = new Map(input.next.steps.map((s) => [s.id, s]));
  const deliveredSteps = new Set(input.delivered.map((d) => d.stepId));
  for (const old of input.approved.steps) {
    const status = input.steps.find((s) => s.id === old.id)?.status;
    const locked = status === 'done' || deliveredSteps.has(old.id);
    if (!locked) continue;
    const now = next.get(old.id);
    const why = status === 'done' ? 'is done' : 'already delivered results';
    if (!now) problems.push(`Step ${old.id} ${why}, so it cannot be removed.`);
    else if (!jsonEqual(old, now)) problems.push(`Step ${old.id} ${why}, so it cannot change.`);
  }
  return problems;
}

/** Steps of the approved plan that `next` drops and that are not done. */
function removedSteps(approved: Plan | null, next: Plan, steps: AgencyStep[]): string[] {
  if (approved === null) return [];
  const kept = new Set(next.steps.map((s) => s.id));
  return approved.steps
    .map((s) => s.id)
    .filter((id) => !kept.has(id) && steps.find((s) => s.id === id)?.status !== 'done');
}

/** Running steps whose role, runtime or model `next` changes. */
function swappedSteps(
  approved: Plan | null,
  next: Plan,
  steps: AgencyStep[],
  liveCrew: CrewRecord[]
): StepSwap[] {
  if (approved === null) return [];
  const before = new Map(approved.steps.map((s) => [s.id, s]));
  return next.steps.flatMap((step): StepSwap[] => {
    const old = before.get(step.id);
    if (!old) return [];
    const running =
      steps.find((s) => s.id === step.id)?.status === 'running' ||
      liveCrew.some((c) => c.stepId === step.id);
    const fields = SWAP_FIELDS.filter((f) => old[f] !== step[f]);
    return running && fields.length > 0 ? [{ stepId: step.id, fields }] : [];
  });
}

/**
 * What approving `next` does, for the change card before and the approval
 * itself: removed steps' crew stop and their open questions are withdrawn,
 * and a running step whose role, runtime or model changes is swapped (its crew
 * stops first, so a worktree never has two writers).
 */
export function planEffects(input: {
  approved: Plan | null;
  next: Plan;
  steps: AgencyStep[];
  liveCrew: CrewRecord[];
  questions: AgencyQuestion[];
  delivered: Delivered[];
  spendUsd: number;
}): PlanEffects {
  const removed = new Set(removedSteps(input.approved, input.next, input.steps));
  const swaps = swappedSteps(input.approved, input.next, input.steps, input.liveCrew);
  const swapped = new Set(swaps.map((s) => s.stepId));
  return {
    stopCrew: input.liveCrew
      .filter((c) => removed.has(c.stepId) || swapped.has(c.stepId))
      .map((c) => ({ crewId: c.id, stepId: c.stepId, label: c.label })),
    swaps,
    withdrawnQuestions: input.questions
      .filter((q) => q.step !== null && removed.has(q.step))
      .filter((q) => q.status === 'open' || q.status === 'hidden')
      .map((q) => q.id),
    deliveredResults: input.delivered.length,
    spendUsd: input.spendUsd
  };
}

/** The steps of `next` that are gone from it, given the job's steps so far. */
export function stepsToRemove(steps: AgencyStep[], next: Plan): string[] {
  const kept = new Set(next.steps.map((s) => s.id));
  return steps
    .filter((s) => s.status !== 'removed' && s.status !== 'done' && !kept.has(s.id))
    .map((s) => s.id);
}

/**
 * Whether a version can be approved, edited or rejected: only the newest one,
 * and only while it waits. Anything else is refused with the newest number,
 * so the card can point there.
 */
export function canDecide(
  version: PlanVersionRecord | null,
  newest: PlanVersionRecord | null
): { ok: true } | { ok: false; reason: string; newestVersion?: number } {
  if (version === null) return { ok: false, reason: 'There is no such plan version.' };
  if (newest !== null && newest.id !== version.id) {
    return {
      ok: false,
      reason: `Plan v${version.version} was replaced by v${newest.version}.`,
      newestVersion: newest.version
    };
  }
  if (version.status !== 'proposed') {
    return { ok: false, reason: `Plan v${version.version} is already ${version.status}.` };
  }
  return { ok: true };
}

/**
 * What a job still owes before it counts as delivered: each listed
 * deliverable of a live step with no result of that kind from that step.
 */
export function missingDeliverables(
  plan: Plan,
  steps: AgencyStep[],
  delivered: Delivered[]
): string[] {
  const live = new Set(steps.filter((s) => s.status !== 'removed').map((s) => s.id));
  return plan.steps
    .filter((step) => live.has(step.id))
    .flatMap((step) =>
      step.deliverables
        .filter((d) => !delivered.some((r) => r.stepId === step.id && r.kind === d.kind))
        .map((d) => `${step.id} lists "${d.label}" (${d.kind})`)
    );
}
