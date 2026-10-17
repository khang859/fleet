import { jobDisplayId } from '../../../shared/agency';

const START = '<!-- fleet:part-of-job -->';
const END = '<!-- /fleet:part-of-job -->';

/** One PR of a job as the "Part of job" list names it. */
export type JobPrLink = { member: string; repo: string; number: number; url: string };

/** The list each PR of a job carries: every PR of the job in merge order, this one marked. */
export function jobLinksSection(jobId: number, prs: JobPrLink[], self: string): string {
  return [
    `**Part of Fleet job ${jobDisplayId(jobId)}.** Its PRs merge in this order:`,
    '',
    ...prs.map(
      (p, i) => `${i + 1}. ${p.member}: ${p.repo}#${p.number}${p.url === self ? ' (this PR)' : ''}`
    )
  ].join('\n');
}

/**
 * A PR body with the job's list in it: the list an earlier delivery wrote is
 * replaced, and the rest of the body is kept as it is.
 */
export function withJobLinks(body: string, section: string): string {
  const block = `${START}\n${section}\n${END}`;
  const start = body.indexOf(START);
  const end = body.indexOf(END);
  if (start !== -1 && end > start) {
    return body.slice(0, start) + block + body.slice(end + END.length);
  }
  return body.trim() === '' ? block : `${body.trimEnd()}\n\n${block}`;
}
