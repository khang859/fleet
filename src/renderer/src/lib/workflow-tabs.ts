import type { PaneLeaf, PaneNode } from '../../../shared/types';
import type { RunTab } from '../../../shared/workflows';
import { collectPaneIds } from './pane-tree';

function removeLeaf(node: PaneNode, id: string): PaneNode | null {
  if (node.type === 'leaf') return node.id === id ? null : node;
  const left = removeLeaf(node.children[0], id);
  const right = removeLeaf(node.children[1], id);
  if (!left) return right;
  if (!right) return left;
  return { ...node, children: [left, right] };
}

/** A new pane takes an even share, so a run's agents sit in equal columns. */
function addLeaf(root: PaneNode | null, leaf: PaneLeaf): PaneNode {
  if (!root) return leaf;
  const count = collectPaneIds(root).length;
  return {
    type: 'split',
    direction: 'horizontal',
    ratio: count / (count + 1),
    children: [root, leaf]
  };
}

/** The split tree for a run, keeping what a person already resized. */
export function runTabRoot(current: PaneNode | null, run: RunTab): PaneNode | null {
  let root = current;
  for (const id of current ? collectPaneIds(current) : []) {
    if (!run.paneIds.includes(id) && root) root = removeLeaf(root, id);
  }
  const held = root ? collectPaneIds(root) : [];
  for (const id of run.paneIds) {
    if (!held.includes(id)) root = addLeaf(root, { type: 'leaf', id, cwd: run.cwd });
  }
  return root;
}
