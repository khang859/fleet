import { describe, expect, it } from 'vitest';
import type { CrewPlaybook, RoleDraft } from '../../../../../../shared/agency-crew';
import {
  draftProblem,
  EMPTY_ROLE,
  modelMissing,
  playbookLine,
  rolesUsing,
  roleTitle,
  sameDraft,
  switchNote,
  switchRuntime
} from '../role-draft';

const role = (patch: Partial<RoleDraft> = {}): RoleDraft => ({
  name: 'builder',
  description: 'Builds it.',
  runtime: 'claude',
  stack: false,
  instructions: 'You are the builder.',
  ...patch
});

describe('switchRuntime', () => {
  it('resets the model on the way to another runtime', () => {
    const saved = role({ model: 'opus' });
    expect(switchRuntime(saved, 'eva', saved)).toEqual({
      ...saved,
      runtime: 'eva',
      model: undefined
    });
  });

  it('gives the saved model back on the way back to the saved runtime', () => {
    const saved = role({ model: 'opus' });
    const away = switchRuntime(saved, 'eva', saved);
    expect(switchRuntime(away, 'claude', saved)).toEqual(saved);
  });
});

describe('switchNote', () => {
  it('says nothing while the runtime is the saved one', () => {
    expect(switchNote(role(), role())).toBeNull();
  });

  it('names the model the switch dropped', () => {
    const saved = role({ model: 'opus' });
    expect(switchNote(role({ runtime: 'eva' }), saved)).toBe(
      'Switched from Claude Code. opus only works on Claude Code, so Model is now Runtime default.'
    );
    expect(switchNote(role({ runtime: 'eva' }), role())).toBe(
      'Switched from Claude Code. Model stays Runtime default.'
    );
  });
});

describe('draftProblem', () => {
  it('passes a whole draft and names what a broken one lacks', () => {
    expect(draftProblem(role())).toBeNull();
    expect(draftProblem(EMPTY_ROLE)).toBe('Name is empty.');
    expect(draftProblem(role({ name: 'Data Migrator' }))).toMatch(/^Name is lower-case/);
    expect(draftProblem(role({ description: '' }))).toBe('When to hire is empty.');
    expect(draftProblem(role({ instructions: ' ' }))).toBe('Instructions is empty.');
  });
});

describe('sameDraft', () => {
  it('ignores the whitespace round the instructions and an unset model', () => {
    expect(sameDraft(role({ instructions: '\nYou are the builder.\n' }), role())).toBe(true);
    expect(sameDraft(role({ model: '' }), role())).toBe(true);
    expect(sameDraft(role({ stack: true }), role())).toBe(false);
  });
});

describe('modelMissing', () => {
  const list = [{ id: 'qwen3', contextLimit: null, cost: null }];

  it('flags an eva model the server does not list, and only then', () => {
    expect(modelMissing(role({ runtime: 'eva', model: 'llama' }), list)).toBe(true);
    expect(modelMissing(role({ runtime: 'eva', model: 'qwen3' }), list)).toBe(false);
    expect(modelMissing(role({ runtime: 'eva', model: 'llama' }), null)).toBe(false);
    expect(modelMissing(role({ model: 'any-claude-id' }), list)).toBe(false);
  });
});

describe('rolesUsing', () => {
  it('counts the roles on one model of one runtime', () => {
    const drafts = [
      role({ model: 'opus' }),
      role({ model: 'opus' }),
      role({ runtime: 'eva', model: 'opus' })
    ];
    expect(rolesUsing(drafts, 'claude', 'opus')).toBe(2);
    expect(rolesUsing(drafts, 'claude', undefined)).toBe(0);
  });
});

describe('roleTitle', () => {
  it.each([
    ['data-migrator', 'Data migrator'],
    ['qa', 'QA'],
    ['ui-designer', 'UI designer'],
    ['e2e-tester', 'E2E tester']
  ])('shows %s as %s', (name, title) => {
    expect(roleTitle(name)).toBe(title);
  });
});

describe('playbookLine', () => {
  const step = (id: string, r: string, after: string[] = [], extra = {}) => ({
    id,
    role: r,
    after,
    count: 1,
    ...extra
  });

  it('joins side-by-side steps with + and shows a client gate as you', () => {
    const playbook = {
      name: 'launch',
      steps: [
        step('plan', 'strategist', [], { gate: 'client' }),
        step('copy', 'copywriter', ['plan']),
        step('art', 'designer', ['plan'], { count: 2 }),
        step('edit', 'editor', ['art', 'copy'])
      ]
    } as unknown as CrewPlaybook;
    expect(playbookLine(playbook)).toBe('Strategist → you → Copywriter + Designer ×2 → Editor');
  });
});
