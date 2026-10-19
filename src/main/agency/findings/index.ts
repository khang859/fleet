import type { AgencyJob } from '../../../shared/agency';
import type { AgencyResult, StepStatus } from '../../../shared/agency-jobs';
import { isTextResultFile, readResultText } from '../results/result-files';
import type { AgencyStore } from '../store/agency-store';

/** How many of a step's latest crew reports a job's findings keep. */
const STEP_REPORTS = 3;

/** One step of a job, with what its crew reported. */
export type StepFindings = {
  id: string;
  role: string;
  status: StepStatus;
  /** The step's latest crew reports, oldest first, as the job's record has them. */
  reports: string[];
  /** The step's note, when it says more than its last report. */
  note: string;
};

/** A result, with the whole text a model can read of it: copied text, or its text files. */
export type ResultFindings = { result: AgencyResult; text: string | null };

/** What a job found: its steps' reports and every result it handed back. */
export type Findings = { job: AgencyJob; steps: StepFindings[]; results: ResultFindings[] };

/**
 * What a job found, from its record and its results folder under `home`. Both
 * outlive the job, so a closed job's findings read the same as a delivered one's.
 */
export async function collectFindings(
  store: Pick<AgencyStore, 'getJob' | 'plans' | 'results'>,
  home: string,
  jobId: number
): Promise<Findings | null> {
  const job = store.getJob(jobId);
  if (job === null) return null;
  const crew = store.plans.crewReports(jobId, STEP_REPORTS);
  const steps = store.plans
    .steps(jobId)
    .filter((s) => s.status !== 'removed')
    .map((s): StepFindings => {
      const reports = crew.filter((l) => l.stepId === s.id).map((l) => l.text);
      const last = reports.at(-1) ?? '';
      return {
        id: s.id,
        role: s.role,
        status: s.status,
        reports,
        note: s.note !== '' && !last.endsWith(s.note) ? s.note : ''
      };
    });
  const results = await Promise.all(
    store.results.forJob(jobId).map(async (result) => ({
      result,
      text: await resultText(home, result)
    }))
  );
  return { job, steps, results };
}

async function resultText(home: string, result: AgencyResult): Promise<string | null> {
  const { body } = result;
  if (body.kind === 'copy') return body.text;
  if (!('files' in body)) return null;
  const texts = await Promise.all(
    body.files.filter(isTextResultFile).map(async (file) => {
      const text = await readResultText(home, result.jobId, file.path).catch(() => null);
      return text === null ? null : { name: file.name, text };
    })
  );
  const read = texts.filter((t) => t !== null);
  if (read.length === 0) return null;
  if (read.length === 1) return read[0]?.text ?? null;
  return read.map((t) => `--- ${t.name} ---\n${t.text}`).join('\n\n');
}
