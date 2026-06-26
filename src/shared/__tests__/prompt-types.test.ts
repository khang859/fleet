import { describe, it, expect } from 'vitest';
import { extractPromptVars, fillTemplate, normalizePromptName } from '../prompt-types';

describe('extractPromptVars', () => {
  it('returns distinct variable names in first-seen order', () => {
    expect(extractPromptVars('Hi {{name}}, review {{ file }} for {{name}}')).toEqual([
      'name',
      'file'
    ]);
  });

  it('returns an empty list when there are no tokens', () => {
    expect(extractPromptVars('plain prompt with no vars')).toEqual([]);
  });

  it('allows dashes and dots in names', () => {
    expect(extractPromptVars('{{repo.name}} {{branch-name}}')).toEqual([
      'repo.name',
      'branch-name'
    ]);
  });
});

describe('fillTemplate', () => {
  it('substitutes provided values and tolerates surrounding whitespace', () => {
    expect(fillTemplate('Hello {{name}} on {{ branch }}', { name: 'Ada', branch: 'main' })).toBe(
      'Hello Ada on main'
    );
  });

  it('replaces unknown variables with an empty string', () => {
    expect(fillTemplate('a {{x}} b', {})).toBe('a  b');
  });
});

describe('normalizePromptName', () => {
  it('lowercases and dashes free text', () => {
    expect(normalizePromptName('  Code Review!! ')).toBe('code-review');
  });

  it('keeps existing dashes and word chars', () => {
    expect(normalizePromptName('fix_bug-2')).toBe('fix_bug-2');
  });
});
