import { describe, expect, it } from 'vitest';
import { postTarget, type WorkflowRun } from '../workflows';

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
