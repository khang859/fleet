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
import {
  CLIENT_FILE_CLEANUP_CHARS,
  type ClientFileNote,
  type PreferencesNote
} from '../projects/client-file';
import type { AgencyStore } from '../store/agency-store';
import { findingsHeadline } from '../findings/render';
import { permissionDisplayId } from '../../../shared/agency-permissions';

type SnapshotReader = Pick<
  AgencyStore,
  | 'repo'
  | 'getJob'
  | 'listJobs'
  | 'pastJobs'
  | 'listQuestions'
  | 'plans'
  | 'permissions'
  | 'results'
  | 'spend'
>;

/** How many ended jobs the Bridge's note names, so it knows what it can read back. */
const NOTE_PAST_JOBS = 8;

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

/**
 * The job's plan as Fleet holds it: the version in force with each step's
 * status, a version its checks held back, the budget and what holds the
 * job. Step titles are the Admiral's own words, so they go in a fence.
 */
function planLines(store: SnapshotReader, job: AgencyJob): string[] {
  const approved = store.plans.approved(job.id);
  const pending = store.plans.pending(job.id);
  const lines: string[] = [];
  if (approved === null) {
    lines.push('No plan has started yet; nothing may start. Send one with job_plan.');
  } else {
    const steps = store.plans.steps(job.id);
    const spent = store.spend.jobTotals(job.id);
    const { usd, weekPct } = approved.plan.budget;
    const share =
      weekPct === undefined
        ? ''
        : `, ${pctText(weekPct)} of the weekly Claude limit, about ${pctText(spent.weekPct)} used`;
    lines.push(
      `Plan v${approved.version} in force (${approved.plan.playbook}), budget $${usd}, spent ${usdText(spent.usd)}${share}${baseText(approved.bases)}. Steps:`,
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
      `Plan v${pending.version} did not start: its checks held it back. Fix it and send it again with job_plan.`
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
 * jobs and its own questions. Both get the client's preferences, so a job
 * starts from how the client likes to work.
 */
export function admiralSnapshotNote(
  store: SnapshotReader,
  scope: AdmiralThreadScope,
  preferences: PreferencesNote = { you: null, project: null }
): string {
  const records = recordsNote(store, scope);
  if (preferences.you === null && preferences.project === null) return records;
  return [records, '', ...preferenceLines(preferences)].join('\n');
}

function preferenceLines({ you, project }: PreferencesNote): string[] {
  const lines = [
    "The client's preferences, from their own words and what you learned on past jobs. Follow them, and do not ask what they already settle. The project lines win over the You lines where they disagree."
  ];
  if (you !== null) {
    lines.push('', 'You (every project):', ...layerLines(you));
  }
  if (project !== null) {
    lines.push('', 'This project:', ...layerLines(project));
    if (project.oversize && !project.changedOutside) {
      lines.push(
        `The project lines are over their ${CLIENT_FILE_CLEANUP_CHARS}-character limit. Clean them up with client_file_propose: merge repeats and remove lines that no longer apply.`
      );
    }
  }
  return lines;
}

function layerLines(layer: ClientFileNote): string[] {
  const lines: string[] = [];
  if (layer.changedOutside) {
    lines.push(
      'These changed outside Fleet, and the client has not looked at the change yet. Until they keep it in Settings > Agency > Admiral, this is the version Fleet last wrote, and it takes no proposals.'
    );
  }
  if (layer.text !== '') lines.push(layer.text);
  return lines;
}

/** The jobs that ended lately, so the Bridge knows whose findings it can read back. */
function pastJobLines(store: SnapshotReader, repoId: string): string[] {
  const past = store.pastJobs(repoId, NOTE_PAST_JOBS);
  if (past.length === 0) return [];
  return [
    'Jobs that ended lately, newest first (read what any job found with job_results):',
    ...past.map((job) => `- ${findingsHeadline(job, store.results.forJob(job.id))}`),
    fence('ended job titles', past.map((job) => `${jobDisplayId(job.id)}: ${job.title}`).join('\n'))
  ];
}

/** The job a follow-up was opened from, whose findings it works on. */
function followsLines(store: SnapshotReader, job: AgencyJob): string[] {
  if (job.linkedJobId === null) return [];
  const from = store.getJob(job.linkedJobId);
  const id = jobDisplayId(job.linkedJobId);
  if (from === null) return [`This job follows ${id}, which Fleet has no record of.`];
  return [
    `This job follows ${id} (${from.state}). Read what it found with job_results.`,
    fence(`${id} title`, from.title)
  ];
}

function recordsNote(store: SnapshotReader, scope: AdmiralThreadScope): string {
  const repo = store.repo(scope.repoId)?.name ?? scope.repoId;
  if (scope.jobId === null) {
    const jobs = store.listJobs(scope.repoId);
    const waiting = store.listQuestions(scope.repoId, { statuses: ['open'] });
    return [
      `Fleet's records for this conversation: the Bridge of ${repo}.`,
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
      ...pastJobLines(store, scope.repoId),
      ...questionLines(store, scope)
    ].join('\n');
  }
  const job = store.getJob(scope.jobId);
  if (job === null) return `Fleet has no record of ${jobDisplayId(scope.jobId)}.`;
  const id = jobDisplayId(job.id);
  return [
    `Fleet's records for this conversation: ${id} in ${repo}, state ${job.state}.`,
    fence(id, `Title: ${job.title}\nBrief: ${job.brief}`),
    ...followsLines(store, job),
    ...planLines(store, job),
    ...permissionLines(store, job.id),
    ...questionLines(store, scope)
  ].join('\n');
}
