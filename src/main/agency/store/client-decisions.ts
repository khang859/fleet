import {
  questionDisplayId,
  type AgencyQuestion,
  type ClientDecision,
  type JobState
} from '../../../shared/agency';
import type { PermissionRecord } from './permission-store';

/** The most decisions Done today lists. */
export const DECISIONS_MAX = 50;

/** Local midnight before `now`: where today's decisions start. */
export function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * The client's decisions of the day, newest first, from what the stores
 * hold: questions they answered and permission requests they answered. `jobState` reads where each job stands now.
 */
export function clientDecisions(input: {
  questions: AgencyQuestion[];
  permissions: PermissionRecord[];
  jobState: (jobId: number) => JobState | null;
}): ClientDecision[] {
  const { jobState } = input;
  const questions = input.questions.map(
    (q): ClientDecision => ({
      key: `q:${q.id}`,
      jobId: q.jobId,
      label: `Answered ${questionDisplayId(q.id)}`,
      detail: answerText(q),
      jobState: q.jobId === null ? null : jobState(q.jobId),
      at: q.answeredAt ?? 0
    })
  );
  const permissions = input.permissions.map(
    (p): ClientDecision => ({
      key: `perm:${p.id}`,
      jobId: p.jobId,
      label: p.state === 'allowed' ? 'Allowed once' : 'Denied',
      detail: p.target.split('\n')[0] ?? p.target,
      jobState: jobState(p.jobId),
      at: p.answeredAt ?? 0
    })
  );
  return [...questions, ...permissions].sort((a, b) => b.at - a.at).slice(0, DECISIONS_MAX);
}

/** The option the client picked, or the words they wrote. */
function answerText(q: AgencyQuestion): string | null {
  const option = q.answerOption === null ? undefined : q.options[q.answerOption];
  return option?.label ?? (q.answerText || null);
}
