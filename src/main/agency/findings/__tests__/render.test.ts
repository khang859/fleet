import { describe, expect, it } from 'vitest';
import type { AgencyResult } from '../../../../shared/agency-jobs';
import { agencyJob } from '../../../../shared/__tests__/agency-fixtures';
import type { Findings, ResultFindings } from '../index';
import { findingsHeadline, renderFindings, renderResult } from '../render';

function report(id: number, text: string | null): ResultFindings {
  const result: AgencyResult = {
    id,
    jobId: 7,
    stepId: 'scout-1',
    kind: 'report',
    label: 'Findings',
    listed: true,
    title: `Report ${id}`,
    body: {
      kind: 'report',
      files: [{ name: 'f.md', path: '/home/jobs/7/results/f.md', type: 'text/markdown', size: 1 }]
    },
    changedAfterDelivery: false,
    deliveredAt: 0,
    member: null,
    merge: null
  };
  return { result, text };
}

const job = agencyJob({ id: 7, title: 'Triage', state: 'delivered' });

function findings(results: ResultFindings[], reports: string[] = []): Findings {
  return {
    job,
    steps: [{ id: 'scout-1', role: 'builder', status: 'done', reports, note: '' }],
    results
  };
}

describe('renderFindings', () => {
  it('names the job, its steps with their crew reports, and every result with where its files are', () => {
    const text = renderFindings(
      findings([report(3, '- #12 broken')], ['scout-1 reported done: read 2 issues']),
      6_000
    );
    expect(text).toContain('j7: Triage\nState: delivered');
    expect(text).toContain('- scout-1 (builder): done\n  scout-1 reported done: read 2 issues');
    expect(text).toContain('result#3 report "Findings", from scout-1: Report 3');
    expect(text).toContain('f.md (text/markdown) at /home/jobs/7/results/f.md');
    expect(text).toContain('- #12 broken');
  });

  it('shares the budget between results and says how to read on where it cut', () => {
    const text = renderFindings(
      findings([report(1, 'x'.repeat(5_000)), report(2, 'y'.repeat(5_000))]),
      6_000
    );
    expect(text.length).toBeLessThan(7_000);
    expect(text).toContain('job_results with job 7, result 1 and offset');
    expect(text).toContain('job_results with job 7, result 2 and offset');
  });

  it('says so when a job handed back nothing', () => {
    expect(renderFindings(findings([]), 6_000)).toMatch(/Results:\nNo results\.$/);
  });
});

describe('renderResult', () => {
  it('reads on from an offset, and says when there is nothing there', () => {
    const item = report(1, 'abcdef');
    expect(renderResult(item, 3)).toMatch(/\ndef$/);
    expect(renderResult(item, 6)).toContain('nothing from 6');
    expect(renderResult(report(2, null), 0)).toContain('no text to read');
  });
});

describe('findingsHeadline', () => {
  it('counts the results by kind', () => {
    expect(findingsHeadline(job, [report(1, null).result, report(2, null).result])).toBe(
      'j7: delivered, 2 results (2 report)'
    );
    expect(findingsHeadline(job, [])).toBe('j7: delivered, no results');
  });
});
