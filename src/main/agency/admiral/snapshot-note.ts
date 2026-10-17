import {
  jobDisplayId,
  questionDisplayId,
  type AdmiralThreadScope,
  type AgencyQuestion
} from '../../../shared/agency';
import type { AgencyStore } from '../store/agency-store';

type SnapshotReader = Pick<AgencyStore, 'repo' | 'getJob' | 'listJobs' | 'listQuestions'>;

/** A question as the Admiral needs it to avoid asking it again: every option, and its pick. */
function describeQuestion(q: AgencyQuestion): string[] {
  const lines = [
    `- ${questionDisplayId(q.id)}${q.step === null ? '' : ` (step ${q.step})`}: ${q.question}`
  ];
  q.options.forEach((option, i) => {
    const detail = option.detail === undefined ? '' : ` - ${option.detail}`;
    const pick = q.recommended === i ? ' (your recommendation)' : '';
    lines.push(`  ${i + 1}. ${option.label}${detail}${pick}`);
  });
  return lines;
}

function describeHeld(q: AgencyQuestion): string {
  const dep = q.dependsOn;
  const after =
    dep === null
      ? ''
      : ` (shows if ${questionDisplayId(dep.question)} is answered with option ${dep.option + 1})`;
  return `- ${questionDisplayId(q.id)}: ${q.question}${after}`;
}

function questionLines(store: SnapshotReader, scope: AdmiralThreadScope): string[] {
  const open = store.listQuestions(scope.repoId, { jobId: scope.jobId, statuses: ['open'] });
  const held = store.listQuestions(scope.repoId, { jobId: scope.jobId, statuses: ['hidden'] });
  return [
    ...(open.length === 0
      ? ['No questions are waiting on the client.']
      : [
          'Questions waiting on the client (do not ask these again):',
          ...open.flatMap(describeQuestion)
        ]),
    ...(held.length === 0
      ? []
      : ['Held until an earlier answer picks them:', ...held.map(describeHeld)])
  ];
}

/**
 * What Fleet's records say about an Admiral conversation right now, for the
 * note at the end of every round. Read fresh each round, so an answer that
 * lands mid-turn is in the next one, and compaction cannot lose it.
 *
 * A job thread gets its job and that job's questions; the lobby gets the open
 * jobs and its own questions.
 */
export function admiralSnapshotNote(store: SnapshotReader, scope: AdmiralThreadScope): string {
  const repo = store.repo(scope.repoId)?.name ?? scope.repoId;
  if (scope.jobId === null) {
    const jobs = store.listJobs(scope.repoId);
    const waiting = store.listQuestions(scope.repoId, { statuses: ['open'] });
    return [
      `Fleet's records for this conversation: the lobby of ${repo}.`,
      ...(jobs.length === 0
        ? ['There are no open jobs.']
        : [
            'Open jobs (each is changed only in its own conversation):',
            ...jobs.map((job) => {
              const asks = waiting.filter((q) => q.jobId === job.id).length;
              return `- ${jobDisplayId(job.id)} "${job.title}": ${job.state}, ${asks} question${asks === 1 ? '' : 's'} waiting`;
            })
          ]),
      ...questionLines(store, scope)
    ].join('\n');
  }
  const job = store.getJob(scope.jobId);
  if (job === null) return `Fleet has no record of ${jobDisplayId(scope.jobId)}.`;
  return [
    `Fleet's records for this conversation: ${jobDisplayId(job.id)} "${job.title}" in ${repo}, state ${job.state}.`,
    `Brief: ${job.brief}`,
    ...questionLines(store, scope)
  ].join('\n');
}
