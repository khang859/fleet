import { describe, it, expect } from 'vitest';
import {
  inferCommitType,
  deriveSummary,
  formatCommitSubject,
  formatCommitMessage
} from '../starbase/conventional-commits';

describe('inferCommitType', () => {
  it('returns feat for generic prompts', () => {
    expect(inferCommitType('add a pagination component')).toBe('feat');
    expect(inferCommitType('implement dark mode')).toBe('feat');
    expect(inferCommitType('build the settings page')).toBe('feat');
  });

  it('returns fix for bug/fix prompts', () => {
    expect(inferCommitType('fix the login button not responding')).toBe('fix');
    expect(inferCommitType('patch the memory leak in worker')).toBe('fix');
    expect(inferCommitType('there is a bug in the date formatter')).toBe('fix');
    expect(inferCommitType('apply a hotfix for the crash')).toBe('fix');
  });

  it('returns refactor for restructuring prompts', () => {
    expect(inferCommitType('refactor the auth module')).toBe('refactor');
    expect(inferCommitType('restructure the database queries')).toBe('refactor');
    expect(inferCommitType('cleanup unused imports')).toBe('refactor');
  });

  it('returns test for testing prompts', () => {
    expect(inferCommitType('write unit tests for the parser')).toBe('test');
    expect(inferCommitType('add a test for edge cases')).toBe('test');
  });

  it('returns docs for documentation prompts', () => {
    expect(inferCommitType('update the docs with setup instructions')).toBe('docs');
    expect(inferCommitType('add a doc for the API')).toBe('docs');
  });

  it('returns chore for infra/deps prompts', () => {
    expect(inferCommitType('bump typescript to 5.4')).toBe('chore');
    expect(inferCommitType('upgrade all dependencies')).toBe('chore');
  });

  it('is case-insensitive', () => {
    expect(inferCommitType('FIX THE BROKEN TESTS')).toBe('fix');
    expect(inferCommitType('Refactor AuthService')).toBe('refactor');
  });

  it('uses first-match-wins ordering', () => {
    // "fix" wins over "test" even though both keywords appear
    expect(inferCommitType('fix the broken tests')).toBe('fix');
  });
});

describe('deriveSummary', () => {
  it('takes the first sentence', () => {
    expect(deriveSummary('Fix the login bug. Also update the README.')).toBe('fix the login bug');
  });

  it('lowercases the first character', () => {
    expect(deriveSummary('Build a caching layer')).toBe('build a caching layer');
  });

  it('truncates to maxLen with ellipsis', () => {
    const long = 'a'.repeat(100);
    const result = deriveSummary(long, 20);
    expect(result.length).toBe(20);
    expect(result.endsWith('…')).toBe(true);
  });

  it('takes only the first line for multi-line prompts', () => {
    expect(deriveSummary('first line\nsecond line')).toBe('first line');
  });

  it('trims whitespace', () => {
    expect(deriveSummary('  add a feature  ')).toBe('add a feature');
  });
});

describe('formatCommitSubject', () => {
  it('produces type(scope): summary format', () => {
    expect(formatCommitSubject('feat', 'auth', 'add oauth support')).toBe(
      'feat(auth): add oauth support'
    );
  });
});

describe('formatCommitMessage', () => {
  it('includes subject and Signed-off-by trailer', () => {
    const msg = formatCommitMessage('fix', 'api', 'correct status code');
    const lines = msg.split('\n');
    expect(lines[0]).toBe('fix(api): correct status code');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('Signed-off-by: Fleet - Starcommand');
  });
});
