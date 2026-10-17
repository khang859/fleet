import { fence } from '../../../shared/fleet-tools';
import {
  jobDisplayId,
  optionLines,
  questionDisplayId,
  type AdmiralThreadScope,
  type AgencyQuestion
} from '../../../shared/agency';
import type { AgencyStore } from '../store/agency-store';

type SnapshotReader = Pick<AgencyStore, 'repo' | 'getJob' | 'listJobs' | 'listQuestions'>;

/**
 * A question as the Admiral needs it to avoid asking it again: every option,
 * and its pick. The wording is the Admiral's own, so it is quoted in a fence:
 * Fleet vouches for the id and the status, not for what the text says.
 */
function describeQuestion(q: AgencyQuestion): string {
  const id = questionDisplayId(q.id);
  const step = q.step === null ? '' : ` (step ${q.step})`;
  return fence(
    id,
    [`${id}${step}: ${q.question}`, ...optionLines(q, 'your recommendation')].join('\n')
  );
}

function describeHeld(q: AgencyQuestion): string {
  const id = questionDisplayId(q.id);
  const dep = q.dependsOn;
  const after =
    dep === null
      ? ''
      : `Shows if ${questionDisplayId(dep.question)} is answered with option ${dep.option + 1}:\n`;
  return `${after}${fence(id, `${id}: ${q.question}`)}`;
}

function questionLines(store: SnapshotReader, scope: AdmiralThreadScope): string[] {
  const open = store.listQuestions(scope.repoId, { jobId: scope.jobId, statuses: ['open'] });
  const held = store.listQuestions(scope.repoId, { jobId: scope.jobId, statuses: ['hidden'] });
  return [
    ...(open.length === 0
      ? ['No questions are waiting on the client.']
      : [
          'Questions waiting on the client (do not ask these again):',
          ...open.map(describeQuestion)
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
 * jobs and its own questions. Both get the client file, so a job starts from
 * how the client likes to work.
 */
export function admiralSnapshotNote(
  store: SnapshotReader,
  scope: AdmiralThreadScope,
  clientFile: string | null = null
): string {
  const records = recordsNote(store, scope);
  if (clientFile === null) return records;
  return [
    records,
    '',
    "The client file: the client's standing preferences for this project, written by their own answers and picks. Follow it, and do not ask what it already settles.",
    clientFile
  ].join('\n');
}

function recordsNote(store: SnapshotReader, scope: AdmiralThreadScope): string {
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
              return `- ${jobDisplayId(job.id)}: ${job.state}, ${asks} question${asks === 1 ? '' : 's'} waiting`;
            }),
            fence(
              'job titles',
              jobs.map((job) => `${jobDisplayId(job.id)}: ${job.title}`).join('\n')
            )
          ]),
      ...questionLines(store, scope)
    ].join('\n');
  }
  const job = store.getJob(scope.jobId);
  if (job === null) return `Fleet has no record of ${jobDisplayId(scope.jobId)}.`;
  const id = jobDisplayId(job.id);
  return [
    `Fleet's records for this conversation: ${id} in ${repo}, state ${job.state}.`,
    fence(id, `Title: ${job.title}\nBrief: ${job.brief}`),
    ...questionLines(store, scope)
  ].join('\n');
}
