import type { AgencyJob, AgencySnapshot } from '../../../../shared/agency';
import type { AgencyPlanVersion, MemberBase } from '../../../../shared/agency-jobs';
import type { AgentToolCall } from '../../../../shared/agent-tools';

/** How a job that ended is labeled wherever it shows. */
export const ENDED_LABEL: Partial<Record<AgencyJob['state'], string>> = {
  closed: 'Closed',
  cancelled: 'Cancelled',
  failed: 'Failed'
};

/**
 * Where a lobby line about a job leads: its tab while the job is open, and
 * how it ended once it has none. Neither for a job older than the past list.
 */
export function jobLink(
  snapshot: AgencySnapshot | undefined,
  jobId: number
): { open: boolean; ended: string | null } {
  const past = snapshot?.pastJobs.find((j) => j.id === jobId);
  return {
    open: snapshot?.jobs.some((j) => j.id === jobId) === true,
    ended: past === undefined ? null : (ENDED_LABEL[past.state] ?? past.state)
  };
}

/** The colour a job's dot and status line take. */
export type JobTone = 'green' | 'amber' | 'blue' | 'muted';

export type JobStatus = { label: string; tone: JobTone };

/**
 * What a job is doing, in the client's words, for its tab and its sheet. A
 * question waiting on the client outranks everything, because it is the one
 * state that is theirs to change; a turn running on the job says it is being
 * worked on whatever the job's own state says.
 */
export function jobStatus(
  job: Pick<AgencyJob, 'state'>,
  live: { asking: boolean; working: boolean }
): JobStatus {
  if (live.asking) return { label: 'Waiting on you', tone: 'amber' };
  if (live.working) return { label: 'Working', tone: 'green' };
  switch (job.state) {
    case 'briefing':
      return { label: 'Briefing', tone: 'blue' };
    case 'planned':
      return { label: 'Plan ready', tone: 'blue' };
    case 'running':
      return { label: 'Working', tone: 'green' };
    case 'waiting':
      return { label: 'Waiting on you', tone: 'amber' };
    case 'delivered':
      return { label: 'Delivered', tone: 'green' };
    case 'interrupted':
      return { label: 'Interrupted', tone: 'amber' };
    case 'closing':
      return { label: 'Closing', tone: 'muted' };
    case 'closed':
      return { label: 'Closed', tone: 'muted' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'muted' };
    case 'failed':
      return { label: 'Failed', tone: 'muted' };
  }
}

/** The Tailwind class for a tone's dot. */
export const TONE_DOT: Record<JobTone, string> = {
  green: 'bg-green-400',
  amber: 'bg-amber-400',
  blue: 'bg-blue-400',
  muted: 'bg-fleet-text-subtle'
};

/** The question id an `ask_client` call put up, read off what it returned. */
export function askedQuestionId(call: Pick<AgentToolCall, 'result' | 'summary'>): number | null {
  return tokenId(/\bq(\d+)\b/, call.summary ?? call.result);
}

/** The plan version a `job_plan` call put up, read off its row. */
export function proposedPlanId(call: Pick<AgentToolCall, 'summary'>): number | null {
  return tokenId(/\bplan#(\d+)\b/, call.summary);
}

/** The result a `job_deliver` call put up, read off its row. */
export function deliveredResultId(call: Pick<AgentToolCall, 'summary'>): number | null {
  return tokenId(/\bresult#(\d+)\b/, call.summary);
}

/** The settings card a `settings_change` call put up, read off its row. */
export function settingsCardId(call: Pick<AgentToolCall, 'summary'>): number | null {
  return tokenId(/\bcard s(\d+)\b/, call.summary);
}

/** The permission request a `permission_answer` call answered, read off its row. */
export function answeredPermissionId(call: Pick<AgentToolCall, 'summary'>): number | null {
  return tokenId(/\bperm#(\d+)\b/, call.summary);
}

/** The number an id token in a tool row carries, like q7 or plan#12. */
function tokenId(token: RegExp, text: string | null | undefined): number | null {
  const match = token.exec(text ?? '');
  return match ? Number(match[1]) : null;
}

/** Dollars as the sheet shows them: whole when whole, else to the cent. */
export function formatUsd(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** A crew runtime by the name the client knows it. */
export function runtimeName(runtime: 'claude' | 'eva'): string {
  return runtime === 'claude' ? 'Claude Code' : 'eva';
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `4m`, or `45s` in the last minute. */
export function leftText(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return sec >= 60 ? `${Math.ceil(sec / 60)}m` : `${sec}s`;
}

/** A member not pinned yet whose default branch tip and HEAD differ: the client picks where it starts. */
export function baseChoice(base: MemberBase): boolean {
  return (
    base.pinned === null &&
    base.defaultSha !== null &&
    base.headSha !== null &&
    base.defaultSha !== base.headSha
  );
}

/**
 * Whether approving a version takes a choice only its full card asks for:
 * steps whose cost Fleet cannot measure, what a swapped step does with its
 * work so far, or where a member's work starts.
 */
export function needsChoices(version: AgencyPlanVersion): boolean {
  return (
    version.checks.issues.some((i) => i.severity === 'accept') ||
    (version.effects?.swaps.length ?? 0) > 0 ||
    version.checks.bases.some(baseChoice)
  );
}
