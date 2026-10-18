import { fence } from '../../../shared/fleet-tools';
import {
  jobDisplayId,
  optionLines,
  questionDisplayId,
  type AdmiralThreadScope,
  type AgencyQuestion
} from '../../../shared/agency';
import type { AgencyJob } from '../../../shared/agency';
import type { PlanBases } from '../../../shared/agency-jobs';
import { pctText, usdText } from '../../../shared/agency-spend';
import { CLIENT_FILE_CLEANUP_CHARS, type ClientFileNote } from '../projects/client-file';
import type { AgencyStore } from '../store/agency-store';
import { proposalLines } from '../wakeup-text';
import { permissionDisplayId } from '../../../shared/agency-permissions';

type SnapshotReader = Pick<
  AgencyStore,
  'repo' | 'getJob' | 'listJobs' | 'listQuestions' | 'plans' | 'permissions' | 'spend'
>;

/** The commits a job's work starts from, as the approval pinned them. */
function baseText(bases: PlanBases | null): string {
  const pins = Object.entries(bases ?? {});
  if (pins.length === 0) return '';
  return `, starting from ${pins.map(([member, pin]) => `${member} at ${pin.sha.slice(0, 12)} (${pin.from === 'head' ? 'its HEAD' : 'default branch tip'})`).join(', ')}`;
}

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
    [
      `${id}${step}: ${q.question}`,
      ...(q.proposal === null ? [] : proposalLines(q.proposal)),
      ...optionLines(q, 'your recommendation')
    ].join('\n')
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

/**
 * The job's plan as Fleet holds it: the approved version with each step's
 * status, the version waiting on the client, the budget and what holds the
 * job. Step titles are the Admiral's own words, so they go in a fence.
 */
function planLines(store: SnapshotReader, job: AgencyJob): string[] {
  const approved = store.plans.approved(job.id);
  const pending = store.plans.pending(job.id);
  const lines: string[] = [];
  if (approved === null) {
    lines.push('No plan is approved yet; nothing may start. Propose one with job_plan.');
  } else {
    const steps = store.plans.steps(job.id);
    const spent = store.spend.jobTotals(job.id);
    const { usd, weekPct } = approved.plan.budget;
    const share =
      weekPct === undefined
        ? ''
        : `, ${pctText(weekPct)} of the weekly Claude limit, about ${pctText(spent.weekPct)} used`;
    lines.push(
      `Approved plan v${approved.version} (${approved.plan.playbook}), budget $${usd}, spent ${usdText(spent.usd)}${share}${baseText(approved.bases)}. Steps:`,
      fence(
        `plan v${approved.version}`,
        approved.plan.steps
          .map((step) => {
            const status = steps.find((s) => s.id === step.id)?.status ?? 'pending';
            const after = step.after.length === 0 ? '' : `, after ${step.after.join(', ')}`;
            return `- ${step.id} (${step.role}${after}): ${status}. ${step.title}`;
          })
          .join('\n')
      )
    );
  }
  if (pending !== null) {
    lines.push(
      `Plan v${pending.version} is waiting on the client; do not propose it again. A new job_plan replaces it.`
    );
  }
  if (job.holds.length > 0) lines.push(`On hold: ${job.holds.join(', ')}.`);
  return lines;
}

/**
 * The permission requests of a job that wait on the Admiral, and those on the
 * client's cards. What a request would run comes from its crew member, so it
 * goes in a fence.
 */
function permissionLines(store: SnapshotReader, jobId: number): string[] {
  const all = store.permissions.forJob(jobId);
  const mine = all.filter((p) => p.state === 'admiral');
  const theirs = all.filter((p) => p.state === 'client');
  return [
    ...(mine.length === 0
      ? []
      : [
          'Permission requests waiting on you (answer each with permission_answer first):',
          ...mine.map((p) => {
            const id = permissionDisplayId(p.id);
            return fence(
              id,
              `${id}: ${p.crewLabel} asks to use ${p.tool} on step ${p.stepId}:\n${p.target}`
            );
          })
        ]),
    ...(theirs.length === 0
      ? []
      : [
          `Permission requests on the client's cards: ${theirs.map((p) => permissionDisplayId(p.id)).join(', ')}.`
        ])
  ];
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
  clientFile: ClientFileNote | null = null
): string {
  const records = recordsNote(store, scope);
  if (clientFile === null) return records;
  return [records, '', ...clientFileLines(store, scope.repoId, clientFile)].join('\n');
}

function clientFileLines(
  store: SnapshotReader,
  repoId: string,
  clientFile: ClientFileNote
): string[] {
  const lines = [
    "The client file: the client's standing preferences for this project, written by their own answers and picks. Follow it, and do not ask what it already settles."
  ];
  if (clientFile.changedOutside) {
    lines.push(
      'It changed outside Fleet, and the client has not looked at the change yet. Until they keep it in Settings > Agency > Admiral, this is the version Fleet last wrote, and it takes no proposals.'
    );
  }
  if (clientFile.text !== '') lines.push(clientFile.text);
  const proposing = store
    .listQuestions(repoId, { statuses: ['open'] })
    .some((q) => q.kind === 'client_file');
  if (clientFile.oversize && !clientFile.changedOutside && !proposing) {
    lines.push(
      `The client file is over its ${CLIENT_FILE_CLEANUP_CHARS}-character limit. Propose a cleanup with client_file_propose: merge repeats and remove lines that no longer apply.`
    );
  }
  return lines;
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
    ...planLines(store, job),
    ...permissionLines(store, job.id),
    ...questionLines(store, scope)
  ].join('\n');
}
