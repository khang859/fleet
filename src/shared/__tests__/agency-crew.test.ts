import { describe, expect, it } from 'vitest';
import {
  checkPlaybook,
  PlaybookFrontmatter,
  RoleFrontmatter,
  type PlaybookStep
} from '../agency-crew';

const ROLES = new Set(['architect', 'builder', 'reviewer']);

function steps(...list: Array<Partial<PlaybookStep> & { id: string }>): PlaybookStep[] {
  return list.map((s) => PlaybookFrontmatter.shape.steps.element.parse({ role: 'builder', ...s }));
}

describe('RoleFrontmatter', () => {
  it('fills runtime and stack when a role leaves them out', () => {
    expect(RoleFrontmatter.parse({ name: 'builder', description: 'Builds.' })).toEqual({
      name: 'builder',
      description: 'Builds.',
      runtime: 'claude',
      stack: false
    });
  });

  it('refuses an unknown runtime, a bad name and a misspelt key', () => {
    expect(RoleFrontmatter.safeParse({ name: 'b', description: 'x', runtime: 'gpt' }).success).toBe(
      false
    );
    expect(RoleFrontmatter.safeParse({ name: 'Builder', description: 'x' }).success).toBe(false);
    expect(RoleFrontmatter.safeParse({ name: 'b', description: 'x', modle: 'opus' }).success).toBe(
      false
    );
  });
});

describe('PlaybookFrontmatter', () => {
  it('reads the three workspace forms and fills step defaults', () => {
    const parsed = PlaybookFrontmatter.parse({
      name: 'eng',
      description: 'Engineering.',
      steps: [
        { id: 'build', role: 'builder' },
        { id: 'merge', role: 'builder', after: ['build'], workspace: { integrate: ['build'] } },
        {
          id: 'review',
          role: 'reviewer',
          after: ['merge'],
          workspace: { of: 'merge' },
          gate: 'client'
        }
      ]
    });
    expect(parsed.steps[0]).toEqual({
      id: 'build',
      role: 'builder',
      count: 1,
      after: [],
      workspace: 'new',
      scopes: []
    });
    expect(parsed.steps[2].workspace).toEqual({ of: 'merge' });
  });

  it('refuses a playbook with no steps, a bad step id and an unknown gate', () => {
    const base = { name: 'eng', description: 'Engineering.' };
    expect(PlaybookFrontmatter.safeParse({ ...base, steps: [] }).success).toBe(false);
    expect(
      PlaybookFrontmatter.safeParse({ ...base, steps: [{ id: 'Build', role: 'builder' }] }).success
    ).toBe(false);
    expect(
      PlaybookFrontmatter.safeParse({
        ...base,
        steps: [{ id: 'b', role: 'builder', gate: 'admiral' }]
      }).success
    ).toBe(false);
  });
});

describe('checkPlaybook', () => {
  it('passes a playbook whose roles exist and whose steps wait in order', () => {
    const list = steps(
      { id: 'design', role: 'architect' },
      { id: 'build', count: 2, after: ['design'], scopes: ['server', 'client'] },
      { id: 'merge', after: ['build'], workspace: { integrate: ['build'] } },
      { id: 'review', role: 'reviewer', after: ['merge'], workspace: { of: 'merge' } }
    );
    expect(checkPlaybook({ steps: list }, ROLES)).toEqual([]);
  });

  it('names a role that is not a role', () => {
    expect(checkPlaybook({ steps: steps({ id: 'a', role: 'wizard' }) }, ROLES)).toEqual([
      'Step a uses role wizard, which is not a role.'
    ]);
  });

  it('names a wait loop, and a workspace read against the waits', () => {
    const loop = steps({ id: 'a', after: ['b'] }, { id: 'b', after: ['a'] });
    expect(checkPlaybook({ steps: loop }, ROLES).join(' ')).toContain('loop');
    const through = steps({ id: 'a', workspace: { of: 'b' } }, { id: 'b', after: ['a'] });
    expect(checkPlaybook({ steps: through }, ROLES)).toContain(
      "Step a works in b's output, so it has to wait for b."
    );
  });

  it('wants a step to wait for the step whose output it works in', () => {
    const list = steps({ id: 'a' }, { id: 'b', workspace: { of: 'a' } });
    expect(checkPlaybook({ steps: list }, ROLES)).toEqual([
      "Step b works in a's output, so it has to wait for a."
    ]);
  });

  it('wants side-by-side members to have scopes and a step that integrates them', () => {
    const list = steps({ id: 'a', count: 2, scopes: ['x', 'x'] });
    expect(checkPlaybook({ steps: list }, ROLES)).toEqual([
      'Step a has 2 members, so it needs 2 different scopes.',
      'Step a has 2 members, so a later step has to integrate it.'
    ]);
    expect(checkPlaybook({ steps: steps({ id: 'a', scopes: ['x'] }) }, ROLES)).toEqual([
      'Step a has one member, so it takes no scopes.'
    ]);
  });
});
