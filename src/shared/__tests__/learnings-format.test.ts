import { describe, it, expect } from 'vitest';
import { learningToMarkdown, slugifyTitle } from '../learnings';

describe('learningToMarkdown', () => {
  it('renders title, body, and a Tags footer', () => {
    const md = learningToMarkdown({
      title: 'xterm sizing',
      body: '## Fix\nUse an inner div.',
      tags: ['xterm', 'layout']
    });
    expect(md).toBe('# xterm sizing\n\n## Fix\nUse an inner div.\n\nTags: xterm, layout\n');
  });

  it('omits the Tags footer when there are none', () => {
    const md = learningToMarkdown({ title: 'T', body: 'body', tags: [] });
    expect(md).toBe('# T\n\nbody\n');
  });

  it('collapses newlines in the title so it stays a single H1', () => {
    const md = learningToMarkdown({
      title: 'Fix node-pty\n# NUL device gotcha',
      body: 'body',
      tags: []
    });
    expect(md).toBe('# Fix node-pty # NUL device gotcha\n\nbody\n');
    // Exactly one H1 line.
    expect(md.split('\n').filter((line) => line.startsWith('# '))).toHaveLength(1);
  });
});

describe('slugifyTitle', () => {
  it('lowercases, hyphenates, and trims', () => {
    expect(slugifyTitle('better-sqlite3 ABI mismatch!')).toBe('better-sqlite3-abi-mismatch');
  });

  it('falls back when the title has no usable characters', () => {
    expect(slugifyTitle('***')).toBe('learning');
  });

  it('caps length', () => {
    expect(slugifyTitle('x'.repeat(100)).length).toBeLessThanOrEqual(60);
  });
});
