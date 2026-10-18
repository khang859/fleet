import type { PaneLeaf, PaneNode } from '../../../shared/types';

/** The leaf nearest the root, first in reading order: the largest pane, splits being even. */
function shallowestLeaf(root: PaneNode): { id: string; depth: number } {
  let level: PaneNode[] = [root];
  for (let depth = 0; ; depth++) {
    const leaf = level.find((n): n is PaneLeaf => n.type === 'leaf');
    if (leaf !== undefined) return { id: leaf.id, depth };
    level = level.flatMap((n) => (n.type === 'split' ? n.children : []));
  }
}

/**
 * A job tab with one more crew pane. The largest pane is halved, side by side
 * at an even depth and one above the other at an odd one, so two panes sit
 * side by side and four make a grid.
 */
export function addCrewPane(root: PaneNode, leaf: PaneLeaf): PaneNode {
  const target = shallowestLeaf(root);
  const direction = target.depth % 2 === 0 ? 'horizontal' : 'vertical';
  const split = (node: PaneNode): PaneNode => {
    if (node.type === 'split')
      return { ...node, children: [split(node.children[0]), split(node.children[1])] };
    if (node.id !== target.id) return node;
    return { type: 'split', direction, ratio: 0.5, children: [node, leaf] };
  };
  return split(root);
}
