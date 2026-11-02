import { describe, expect, it } from 'vitest';
import { postTarget, trustsOnRerun, type WorkflowRun } from '../workflows';

const PR = { number: 7 };
const ISSUE = { number: 9 };

function runOf(fields: object): WorkflowRun {
  return { pr: null, locked: false, ...fields } as WorkflowRun;
}

describe('postTarget', () => {
  it.each([
    ['post-issue with a PR', { pr: PR, issue: ISSUE, finish: { action: 'post-issue' } }, 'issue'],
    ['post-pr with an issue', { pr: PR, issue: ISSUE, finish: { action: 'post-pr' } }, 'pr'],
    ['no action with both', { pr: PR, issue: ISSUE }, 'pr'],
    ['an issue only', { issue: ISSUE }, 'issue'],
    ['a PR only', { pr: PR }, 'pr']
  ])('picks for %s', (_name, fields, kind) => {
    expect(postTarget(runOf(fields))?.kind).toBe(kind);
  });

  it('labels each target', () => {
    expect(postTarget(runOf({ pr: PR }))?.label).toBe('PR #7');
    expect(postTarget(runOf({ issue: ISSUE }))?.label).toBe('issue #9');
  });

  it('has no target with neither', () => {
    expect(postTarget(runOf({}))).toBeNull();
  });
});

describe('trustsOnRerun', () => {
  it('keeps the trust of a PR run', () => {
    expect(trustsOnRerun(runOf({ pr: PR }))).toBe(true);
  });

  it('keeps a locked run locked', () => {
    expect(trustsOnRerun(runOf({ pr: PR, locked: true }))).toBe(false);
  });

  it('checks the authors of an issue again', () => {
    expect(trustsOnRerun(runOf({ issue: ISSUE }))).toBe(false);
  });
});
