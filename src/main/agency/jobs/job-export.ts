import {
  jobDisplayId,
  optionLines,
  questionDisplayId,
  type AgencyQuestion
} from '../../../shared/agency';
import type { AgencyJobDetail, AgencyPlanVersion, AgencyResult } from '../../../shared/agency-jobs';
import { proposalLines } from '../wakeup-text';

/** What a job's export is made from: its detail, its questions, and its project's name. */
export type JobRecord = {
  project: string;
  detail: AgencyJobDetail;
  questions: AgencyQuestion[];
};

/** Shorter values would hide too much of the record behind the mask. */
const SECRET_MIN_CHARS = 6;

/** A local time as `2026-10-17 14:05`. */
function stamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function planSection(v: AgencyPlanVersion): string[] {
  const by = v.author === 'client' ? 'the client' : 'the Admiral';
  const decided = v.decidedAt === null ? '' : `, decided ${stamp(v.decidedAt)}`;
  const lines = [
    `### v${v.version}: ${v.status}`,
    '',
    `Proposed by ${by} ${stamp(v.proposedAt)}${decided}. Playbook ${v.plan.playbook}, budget $${v.plan.budget.usd}.`,
    '',
    v.plan.summary,
    '',
    ...v.plan.steps.map((s) => {
      const gives = s.deliverables.map((d) => d.label).join(', ');
      return `- ${s.id} (${s.role}): ${s.title}${gives === '' ? '' : `. Hands back: ${gives}`}`;
    })
  ];
  if (v.plan.asksFirst.length > 0) lines.push('', `Asks first: ${v.plan.asksFirst.join('; ')}`);
  if (v.decisionNote !== null) lines.push('', `Client's note: ${v.decisionNote}`);
  return [...lines, ''];
}

function answerLine(q: AgencyQuestion): string {
  if (q.answeredAt === null) {
    return q.status === 'withdrawn'
      ? `Withdrawn${q.withdrawnReason === null ? '' : `: ${q.withdrawnReason}`}.`
      : 'Not answered.';
  }
  const pick = q.answerOption;
  const option = pick === null ? null : `${pick + 1}. ${q.options[pick]?.label ?? ''}`;
  const said = [option, q.answerText]
    .filter((s): s is string => s !== null && s !== '')
    .join(' - ');
  return `Answer${q.late ? ' (late)' : ''}: ${said}`;
}

function questionSection(q: AgencyQuestion): string[] {
  return [
    `### ${questionDisplayId(q.id)}: ${q.question}`,
    '',
    ...(q.context === '' ? [] : [q.context, '']),
    ...(q.proposal === null ? [] : [...proposalLines(q.proposal).map((l) => `- ${l}`), '']),
    ...optionLines(q, 'recommended').map((l) => `- ${l}`),
    '',
    answerLine(q),
    ''
  ];
}

function resultLine(r: AgencyResult): string {
  const head = `- ${r.label}${r.listed ? '' : ' (extra)'}, from ${r.stepId}`;
  const body = r.body;
  switch (body.kind) {
    case 'pr':
      return `${head}: PR #${body.pr.number} ${body.pr.title} (${body.pr.state}) ${body.pr.url}`;
    case 'branch':
      return `${head}: branch ${body.branch} at ${body.sha.slice(0, 12)}`;
    case 'copy':
      return `${head}: ${r.title}\n\n${body.text.replace(/^/gm, '  > ')}`;
    case 'preview':
    case 'link':
      return `${head}: ${r.title} ${body.url}`;
    case 'doc':
    case 'image':
    case 'review':
    case 'report':
    case 'file':
      return `${head}: ${r.title} (${body.files.map((f) => f.name).join(', ')})`;
  }
}

/** The job's states and its log, in the order they happened. */
function recordLines(detail: AgencyJobDetail): string[] {
  const rows = [
    ...detail.events.map((e) => ({
      at: e.at,
      text: `${e.from ?? 'new'} -> ${e.to}${e.reason === '' ? '' : `: ${e.reason}`}`
    })),
    ...detail.log.map((l) => ({
      at: l.at,
      text: `${l.stepId === null ? '' : `${l.stepId}: `}${l.text}`
    }))
  ].sort((a, b) => a.at - b.at);
  return rows.map((r) => `- ${stamp(r.at)} ${r.text}`);
}

/** Every value in `secrets` masked, so an env file's values never leave in an export. */
function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((s) => s.length >= SECRET_MIN_CHARS)
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.split(secret).join('[env value]'), text);
}

/**
 * A job's record as Markdown, for the client to keep or share: the brief,
 * every plan version and its decision, the questions and answers, the
 * results, the spend, and every state change and log line. The values of the
 * project's chosen env files are masked wherever they appear.
 */
export function exportJob(record: JobRecord, secrets: readonly string[] = []): string {
  const { job, versions, steps, results, spendUsd } = record.detail;
  const budget = job.budgetUsd === null ? '' : ` of a $${job.budgetUsd} budget`;
  const lines = [
    `# ${jobDisplayId(job.id)}: ${job.title}`,
    '',
    `- Project: ${record.project}`,
    `- State: ${job.state}`,
    `- Opened: ${stamp(job.createdAt)}, last change ${stamp(job.updatedAt)}`,
    `- Spent: $${spendUsd.toFixed(2)}${budget}`,
    '',
    '## Brief',
    '',
    job.brief,
    '',
    '## Plan',
    '',
    ...(versions.length === 0 ? ['No plan was proposed.', ''] : versions.flatMap(planSection)),
    '## Steps',
    '',
    ...(steps.length === 0
      ? ['No steps.']
      : steps.map(
          (s) => `- ${s.id} (${s.role}): ${s.status}${s.note === '' ? '' : `. ${s.note}`}`
        )),
    '',
    '## Questions and answers',
    '',
    ...(record.questions.length === 0
      ? ['No questions.', '']
      : record.questions.flatMap(questionSection)),
    '## Results',
    '',
    ...(results.length === 0 ? ['No results.'] : results.map(resultLine)),
    '',
    '## Record',
    '',
    ...recordLines(record.detail),
    ''
  ];
  return redact(lines.join('\n'), secrets);
}
