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

  it('strips HTML tags from the title to avoid stored XSS in exported .md', () => {
    const md = learningToMarkdown({
      title: '<img src=x onerror=alert(1)>Real title',
      body: 'body',
      tags: []
    });
    expect(md).toBe('# Real title\n\nbody\n');
    expect(md).not.toContain('<img');
  });

  it('does not duplicate a Tags footer the body already carries', () => {
    const md = learningToMarkdown({
      title: 'T',
      body: 'Some text.\n\nTags: stale, leftover',
      tags: ['real', 'footer']
    });
    expect(md).toBe('# T\n\nSome text.\n\nTags: real, footer\n');
    expect(md.split('\n').filter((line) => /^tags:/i.test(line))).toHaveLength(1);
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

  it('avoids Windows reserved device names', () => {
    expect(slugifyTitle('NUL')).toBe('nul-file');
    expect(slugifyTitle('con')).toBe('con-file');
    expect(slugifyTitle('COM1')).toBe('com1-file');
    expect(slugifyTitle('LPT9')).toBe('lpt9-file');
    // A name that merely contains a reserved word is fine.
    expect(slugifyTitle('nullable pointers')).toBe('nullable-pointers');
  });
});
