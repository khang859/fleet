import { describe, expect, it } from 'vitest';
import { planSections } from '../plan-sections';

describe('planSections', () => {
  it('lists headings with their level', () => {
    expect(planSections('# One\n\ntext\n\n## Two\n\n### Three')).toEqual([
      { level: 1, title: 'One' },
      { level: 2, title: 'Two' },
      { level: 3, title: 'Three' }
    ]);
  });

  it('skips a comment in a code block', () => {
    expect(planSections('# One\n```sh\n# not a heading\n```\n## Two')).toHaveLength(2);
  });

  it('shows plain text', () => {
    expect(planSections('## Use `foo` and [bar](http://x)')[0].title).toBe('Use foo and bar');
  });

  it('skips deep headings', () => {
    expect(planSections('#### Small')).toEqual([]);
  });
});
