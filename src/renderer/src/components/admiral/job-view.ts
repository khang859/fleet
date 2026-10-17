import type { AgencyJob } from '../../../../shared/agency';
import type { AgentToolCall } from '../../../../shared/agent-tools';

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
  const match = /\bq(\d+)\b/.exec(call.summary ?? call.result ?? '');
  return match ? Number(match[1]) : null;
}
