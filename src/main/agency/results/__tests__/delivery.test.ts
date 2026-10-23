import { describe, expect, it } from 'vitest';
import type { AgencyResult, ResultBody } from '../../../../shared/agency-jobs';
import { deliveryAction } from '../delivery';

const FILES = { files: [{ name: 'a.md', path: '/x/a.md', type: 'text/markdown', size: 1 }] };
const BODY: Record<AgencyResult['kind'], ResultBody> = {
  pr: {
    kind: 'pr',
    pr: {
      number: 1,
      url: 'https://github.com/a/b/pull/1',
      title: 'Fix',
      branch: 'b',
      base: 'main',
      headSha: 'h',
      state: 'open',
      draft: false,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      checks: { passed: 1, failed: 0, pending: 0 }
    }
  },
  branch: { kind: 'branch', branch: 'b', sha: 's' },
  copy: { kind: 'copy', text: 't' },
  preview: { kind: 'preview', url: 'http://localhost' },
  link: { kind: 'link', url: 'https://x' },
  doc: { kind: 'doc', ...FILES },
  image: { kind: 'image', ...FILES },
  review: { kind: 'review', ...FILES },
  report: { kind: 'report', ...FILES },
  file: { kind: 'file', ...FILES }
};

function result(kind: AgencyResult['kind'], listed = true): AgencyResult {
  return {
    id: 1,
    jobId: 1,
    stepId: 's',
    kind,
    label: kind,
    listed,
    title: '',
    body: BODY[kind],
    changedAfterDelivery: false,
    deliveredAt: 0,
    member: null,
    merge: null
  };
}

describe('deliveryAction', () => {
  it('leaves a job of PRs for the client to merge', () => {
    expect(deliveryAction([result('pr'), result('pr')])).toBe('tell');
  });

  it('closes a job that handed back only findings', () => {
    for (const kind of ['doc', 'review', 'report', 'copy', 'link'] as const) {
      expect(deliveryAction([result(kind)])).toBe('close');
    }
    expect(deliveryAction([result('report'), result('copy', false)])).toBe('close');
  });

  it('leaves a job with anything else, or nothing, for the client', () => {
    for (const kind of ['branch', 'preview', 'image', 'file'] as const) {
      expect(deliveryAction([result('report'), result(kind)])).toBe('tell');
    }
    expect(deliveryAction([result('report'), result('pr', false)])).toBe('tell');
    expect(deliveryAction([])).toBe('tell');
    expect(deliveryAction([result('report', false)])).toBe('tell');
  });
});
