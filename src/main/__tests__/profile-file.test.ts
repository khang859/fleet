import { describe, it, expect } from 'vitest';
import { renderProfileMarkdown } from '../kanban/profile-file';
import { isValidProfileName } from '../../shared/types';

describe('renderProfileMarkdown', () => {
  it('renders frontmatter with name, model, and inline skills list, then body', () => {
    const md = renderProfileMarkdown({
      name: 'researcher',
      role: 'worker',
      model: 'claude-opus-4-8',
      skills: ['web-search', 'docs'],
      instructions: 'You research things.'
    });
    expect(md).toContain('---\nname: researcher\n');
    expect(md).toContain('model: claude-opus-4-8\n');
    expect(md).toContain('skills: [web-search, docs]\n');
    expect(md.indexOf('---', 4)).toBeGreaterThan(0); // closing fence present
    expect(md.trimEnd().endsWith('You research things.')).toBe(true);
  });

  it('omits the model line when model is empty', () => {
    const md = renderProfileMarkdown({
      name: 'a',
      role: 'worker',
      model: '',
      skills: [],
      instructions: 'b'
    });
    expect(md).not.toContain('model:');
  });

  it('omits the skills line when there are no skills', () => {
    const md = renderProfileMarkdown({
      name: 'a',
      role: 'worker',
      model: '',
      skills: [],
      instructions: 'b'
    });
    expect(md).not.toContain('skills:');
  });

  it('preserves multi-line instructions in the body', () => {
    const md = renderProfileMarkdown({
      name: 'x',
      role: 'worker',
      model: '',
      skills: [],
      instructions: 'Line 1.\nLine 2.\nLine 3.'
    });
    expect(md).toContain('Line 1.\nLine 2.\nLine 3.');
  });

  it('keeps a --- inside instructions in the body (rune closes frontmatter at the first --- after name)', () => {
    const md = renderProfileMarkdown({
      name: 'x',
      role: 'worker',
      model: '',
      skills: [],
      instructions: 'Intro.\n---\nFooter.'
    });
    // Everything from the blank line after the closing fence onward is the body.
    const body = md.slice(md.indexOf('\n---\n') + 5);
    expect(body).toContain('Intro.');
    expect(body).toContain('Footer.');
  });

  it('omits the model line when model is whitespace-only', () => {
    const md = renderProfileMarkdown({
      name: 'a',
      role: 'worker',
      model: '   ',
      skills: [],
      instructions: 'b'
    });
    expect(md).not.toContain('model:');
  });
});

describe('isValidProfileName', () => {
  it('accepts lowercase alnum with - and _ after the first char', () => {
    expect(isValidProfileName('researcher')).toBe(true);
    expect(isValidProfileName('a1_b-c')).toBe(true);
  });
  it('rejects uppercase, leading punctuation, spaces, and empty', () => {
    expect(isValidProfileName('Researcher')).toBe(false);
    expect(isValidProfileName('-bad')).toBe(false);
    expect(isValidProfileName('has space')).toBe(false);
    expect(isValidProfileName('')).toBe(false);
  });
});
