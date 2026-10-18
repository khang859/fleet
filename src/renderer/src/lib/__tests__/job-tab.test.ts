import { describe, expect, it } from 'vitest';
import type { PaneLeaf, PaneNode } from '../../../../shared/types';
import { addCrewPane } from '../job-tab';

const leaf = (id: string): PaneLeaf => ({ type: 'leaf', id, cwd: '/w' });

/** The tree as nested lists, `|` for side by side and `/` for one above the other. */
function shape(node: PaneNode): unknown {
  if (node.type === 'leaf') return node.id;
  return [node.direction === 'horizontal' ? '|' : '/', ...node.children.map(shape)];
}

describe('addCrewPane', () => {
  it('puts a second pane beside the first', () => {
    expect(shape(addCrewPane(leaf('a'), leaf('b')))).toEqual(['|', 'a', 'b']);
  });

  it('makes a grid of four, halving the largest pane each time', () => {
    let root: PaneNode = leaf('a');
    for (const id of ['b', 'c', 'd']) root = addCrewPane(root, leaf(id));
    expect(shape(root)).toEqual(['|', ['/', 'a', 'c'], ['/', 'b', 'd']]);
  });

  it('goes on to split the panes of the grid side by side', () => {
    let root: PaneNode = leaf('a');
    for (const id of ['b', 'c', 'd', 'e']) root = addCrewPane(root, leaf(id));
    expect(shape(root)).toEqual(['|', ['/', ['|', 'a', 'e'], 'c'], ['/', 'b', 'd']]);
  });

  it('keeps the ratio the user dragged a split to', () => {
    const root: PaneNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.7,
      children: [leaf('a'), leaf('b')]
    };
    const next = addCrewPane(root, leaf('c'));
    expect(next.type === 'split' && next.ratio).toBe(0.7);
  });
});
