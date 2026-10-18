import { describe, expect, it } from 'vitest';
import type { Root } from 'mdast';
import { remarkFrontmatterAsCode } from '../frontmatter-as-code';

const run = (tree: Root): Root => {
  remarkFrontmatterAsCode()(tree);
  return tree;
};

describe('remarkFrontmatterAsCode', () => {
  it('shows the front matter as a yaml code block', () => {
    const tree = run({
      type: 'root',
      children: [
        { type: 'yaml', value: 'name: builder' },
        { type: 'paragraph', children: [{ type: 'text', value: 'Body' }] }
      ]
    });
    expect(tree.children).toEqual([
      { type: 'code', lang: 'yaml', meta: null, value: 'name: builder' },
      { type: 'paragraph', children: [{ type: 'text', value: 'Body' }] }
    ]);
  });

  it('leaves a file with no front matter alone', () => {
    const children: Root['children'] = [{ type: 'thematicBreak' }];
    expect(run({ type: 'root', children }).children).toEqual([{ type: 'thematicBreak' }]);
  });
});
