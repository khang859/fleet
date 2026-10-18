import type { SwapChoice } from '../../../shared/agency-jobs';
import { RUNTIME_LABEL } from '../../../shared/agency-crew';
import type { AgencyStore } from '../store/agency-store';
import { crewRuntime, NOT_STARTED, type CrewRecord } from '../store/crew-store';
import type { ResourceRecord } from '../store/resource-store';
import type { GitWrite } from '../workspaces/job-workspace';

/** A hire that replaces a member an approved plan change swapped out, and how. */
export type CrewSwap = { replaced: CrewRecord; choice: SwapChoice };

/**
 * The swap a hire for `stepId` carries out: the step's last member the
 * approved plan stopped as a swap, while no member since has started.
 * Null for any other hire.
 */
export function pendingSwap(store: AgencyStore, jobId: number, stepId: string): CrewSwap | null {
  const effects = store.plans.approved(jobId)?.effects;
  const choice = effects?.swaps[stepId];
  if (effects == null || choice === undefined) return null;
  const crew = store.crew.all(jobId).filter((c) => c.stepId === stepId);
  const at = crew.findLastIndex((c) => effects.stopCrewIds.includes(c.id));
  if (at < 0) return null;
  const since = crew.slice(at + 1);
  return since.every((c) => c.endReason?.startsWith(NOT_STARTED) === true)
    ? { replaced: crew[at], choice }
    : null;
}

/**
 * What the brief adds for a swapped-in member: who worked on the step before,
 * and for "Continue its work" what it changed since the base in each member
 * it wrote to; for "Start over", that the old branch is not its to use. The
 * step's open questions come along either way. The Admiral's brief carries
 * its summary of the old member's work.
 */
export async function handoffNote(input: {
  swap: CrewSwap;
  /** The parts of the old member's workspace. */
  parts: ResourceRecord[];
  questions: string[];
  git: GitWrite;
}): Promise<string> {
  const { replaced, choice } = input.swap;
  const before = `${replaced.label} worked on this step on ${RUNTIME_LABEL[crewRuntime(replaced)]} before you`;
  const written = input.parts.filter(
    (p) => p.mode === 'writable' && p.path !== null && p.baseSha !== null
  );
  const lines =
    choice === 'continue'
      ? [
          `${before}. You continue its work: its worktree is yours as it left it, uncommitted changes included.`,
          ...(await Promise.all(written.map(async (p) => changesSince(p, input.git))))
        ]
      : [
          `${before}. You start over from the base on a new branch. Its work stays on ${branchesOf(written)}, which you do not use.`
        ];
  if (input.questions.length > 0) {
    lines.push(
      ['Open questions for this step:', ...input.questions.map((q) => `- ${q}`)].join('\n')
    );
  }
  return lines.join('\n\n');
}

/** A part's changes since its base, committed or not, as `git diff --stat` and its new files. */
async function changesSince(part: ResourceRecord, git: GitWrite): Promise<string> {
  const path = part.path ?? '';
  const base = part.baseSha ?? '';
  const where = part.member ?? 'the worktree';
  const stat = ((await git(['diff', '--stat', base], path)) ?? '').trimEnd();
  const added = ((await git(['ls-files', '--others', '--exclude-standard'], path)) ?? '')
    .split('\n')
    .filter((f) => f !== '');
  if (stat === '' && added.length === 0) {
    return `${where} has no changes since the base ${base.slice(0, 7)}.`;
  }
  const parts = [`Changes in ${where} since the base ${base.slice(0, 7)} (git diff ${base}):`];
  if (stat !== '') parts.push(stat);
  if (added.length > 0) parts.push(`New files git does not track yet: ${added.join(', ')}`);
  return parts.join('\n');
}

function branchesOf(parts: ResourceRecord[]): string {
  const names = [...new Set(parts.flatMap((p) => (p.branch === null ? [] : [p.branch])))];
  return names.length === 0 ? 'its old worktree' : `the branch ${names.join(', ')}`;
}
