import { jobDisplayId, type AgencyJob } from '../../../shared/agency';
import type { AgencyResult } from '../../../shared/agency-jobs';
import { resultSummary, resultToken } from '../results';
import type { Findings, ResultFindings, StepFindings } from './index';

/** The most of a job's findings that wake the Bridge: a summary to report from, not the record. */
export const WAKEUP_FINDINGS_CHARS = 6_000;
/** The most of a job's findings one `job_results` call reads. */
export const TOOL_FINDINGS_CHARS = 40_000;
/** No result's text is cut shorter than this, however many share the budget. */
const MIN_TEXT_CHARS = 600;
/** No crew report is cut shorter than this. */
const MIN_REPORT_CHARS = 200;

/**
 * A job's findings as plain text within about `budget` characters: the job,
 * each step with its crew reports, then each result with as much of its text
 * as its share allows. Steps get at most a third of the budget, and the
 * results' text shares the rest evenly. A cut says how to read on.
 *
 * It is crew-written and not fenced here: each caller fences it once.
 */
export function renderFindings(findings: Findings, budget: number): string {
  const { job, steps, results } = findings;
  const reportCount = steps.reduce((n, s) => n + s.reports.length, 0);
  const reportChars = Math.max(MIN_REPORT_CHARS, Math.floor(budget / 3 / Math.max(1, reportCount)));
  const top = [
    `${jobDisplayId(job.id)}: ${job.title}`,
    `State: ${job.state}`,
    '',
    'Steps:',
    ...(steps.length === 0 ? ['No steps.'] : steps.flatMap((s) => stepLines(s, reportChars))),
    '',
    'Results:'
  ];
  if (results.length === 0) return [...top, 'No results.'].join('\n');
  const heads = results.map((r) => resultHead(r.result));
  const used = [...top, ...heads].join('\n').length;
  const withText = results.filter((r) => r.text !== null).length;
  const each = Math.max(MIN_TEXT_CHARS, Math.floor((budget - used) / Math.max(1, withText)));
  const blocks = results.map((r, i) =>
    r.text === null ? heads[i] : `${heads[i]}\n${textWindow(r.result, r.text, 0, each)}`
  );
  return [...top, blocks.join('\n\n')].join('\n');
}

/** One result's text from `offset`, for reading on where the findings cut it. */
export function renderResult(item: ResultFindings, offset: number): string {
  const head = resultHead(item.result);
  if (item.text === null)
    return `${head}\nIt has no text to read; the client opens it from its card.`;
  if (offset >= item.text.length) {
    return `${head}\nIts text is ${item.text.length} characters, so there is nothing from ${offset}.`;
  }
  return `${head}\n${textWindow(item.result, item.text, offset, TOOL_FINDINGS_CHARS)}`;
}

/** A job and what it handed back, in a line, for the Bridge's note. */
export function findingsHeadline(job: AgencyJob, results: AgencyResult[]): string {
  const id = jobDisplayId(job.id);
  if (results.length === 0) return `${id}: ${job.state}, no results`;
  const kinds = new Map<string, number>();
  for (const r of results) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
  const byKind = [...kinds].map(([kind, n]) => `${n} ${kind}`).join(', ');
  return `${id}: ${job.state}, ${results.length} result${results.length === 1 ? '' : 's'} (${byKind})`;
}

function stepLines(step: StepFindings, reportChars: number): string[] {
  return [
    `- ${step.id} (${step.role}): ${step.status}`,
    ...step.reports.map((r) => `  ${clip(r, reportChars)}`),
    ...(step.note === '' ? [] : [`  Note: ${clip(step.note, reportChars)}`])
  ];
}

/** What a result is and where it is, without its text. */
function resultHead(r: AgencyResult): string {
  const head = `${resultToken(r.id)} ${r.kind} "${r.label}"${r.listed ? '' : ' (extra)'}, from ${r.stepId}: ${resultSummary(r)}`;
  if (!('files' in r.body)) return head;
  return `${head}\n${r.body.files.map((f) => `  ${f.name} (${f.type}) at ${f.path}`).join('\n')}`;
}

/** Up to `limit` characters of a result's text from `offset`, saying how to read on when cut. */
function textWindow(result: AgencyResult, text: string, offset: number, limit: number): string {
  const end = Math.min(text.length, offset + limit);
  const shown = text.slice(offset, end);
  if (end >= text.length) return shown;
  return `${shown}\n[cut at ${end} of ${text.length} characters: job_results with job ${result.jobId}, result ${result.id} and offset ${end} reads on]`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
