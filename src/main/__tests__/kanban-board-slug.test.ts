import { describe, it, expect } from 'vitest';
import { deriveBoardSlug, isValidBoardSlug } from '../kanban/board-slug';

describe('board-slug', () => {
  it('lowercases and hyphenates names', () => {
    expect(deriveBoardSlug('Research')).toBe('research');
    expect(deriveBoardSlug('My Board')).toBe('my-board');
    expect(deriveBoardSlug('  Hello   World  ')).toBe('hello-world');
    expect(deriveBoardSlug('Front-end & API')).toBe('front-end-api');
  });

  it('strips non-alphanumerics and leading/trailing hyphens', () => {
    expect(deriveBoardSlug('!!!')).toBe('');
    expect(deriveBoardSlug('café')).toBe('caf');
    expect(deriveBoardSlug('--edge--')).toBe('edge');
  });

  it('truncates to 64 chars with no trailing hyphen', () => {
    const slug = deriveBoardSlug('a'.repeat(80));
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('isValidBoardSlug accepts valid slugs and rejects junk', () => {
    expect(isValidBoardSlug('default')).toBe(true);
    expect(isValidBoardSlug('research-2')).toBe(true);
    expect(isValidBoardSlug('a_b')).toBe(true);
    expect(isValidBoardSlug('')).toBe(false);
    expect(isValidBoardSlug('-bad')).toBe(false);
    expect(isValidBoardSlug('../etc')).toBe(false);
    expect(isValidBoardSlug('a'.repeat(65))).toBe(false);
  });
});
