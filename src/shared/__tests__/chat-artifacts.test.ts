import { describe, it, expect } from 'vitest';
import { extractArtifacts } from '../chat-artifacts';

describe('extractArtifacts', () => {
  it('extracts an html block and titles it from <title>', () => {
    const content = [
      'Here you go:',
      '```html',
      '<html><head><title>My Page</title></head><body>hi there everyone</body></html>',
      '```'
    ].join('\n');
    const arts = extractArtifacts(content);
    expect(arts).toHaveLength(1);
    expect(arts[0].kind).toBe('html');
    expect(arts[0].title).toBe('My Page');
    expect(arts[0].code).toContain('<body>');
  });

  it('falls back to a generic html title when no <title>', () => {
    const content = '```html\n<div>some reasonably long content here</div>\n```';
    expect(extractArtifacts(content)[0].title).toBe('HTML document');
  });

  it('treats svg blocks as artifacts', () => {
    const content = '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>\n```';
    const arts = extractArtifacts(content);
    expect(arts).toHaveLength(1);
    expect(arts[0].kind).toBe('svg');
    expect(arts[0].title).toBe('SVG image');
  });

  it('treats markdown/md blocks as artifacts and titles from the first h1', () => {
    const content = '```markdown\n# Project Plan\n\nLots of detail goes here.\n```';
    const arts = extractArtifacts(content);
    expect(arts[0].kind).toBe('markdown');
    expect(arts[0].title).toBe('Project Plan');
  });

  it('ignores non-renderable languages', () => {
    const content = '```python\nprint("hello world this is long")\n```';
    expect(extractArtifacts(content)).toEqual([]);
  });

  it('skips trivial one-line snippets', () => {
    expect(extractArtifacts('```html\n<br/>\n```')).toEqual([]);
  });

  it('indexes multiple artifacts in document order', () => {
    const content = [
      '```html\n<p>first block with enough text</p>\n```',
      '```svg\n<svg><circle/></svg> plus more content here\n```'
    ].join('\n\n');
    const arts = extractArtifacts(content);
    expect(arts.map((a) => a.index)).toEqual([0, 1]);
    expect(arts.map((a) => a.kind)).toEqual(['html', 'svg']);
  });
});
