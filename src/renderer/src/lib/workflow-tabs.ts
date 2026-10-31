import type { PaneLeaf, PaneNode, PaneSplit } from '../../../shared/types';
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

/** A run's panes fill rows of this many, so many agents stay wide enough to read. */
const PANES_IN_ROW = 3;

function isRows(node: PaneNode): node is PaneSplit {
  return node.type === 'split' && node.direction === 'vertical';
}

function rowCount(node: PaneNode): number {
  return isRows(node) ? 1 + rowCount(node.children[0]) : 1;
}

/** A new pane takes an even share, so a row's panes sit in equal columns. */
function addToRow(row: PaneNode, leaf: PaneLeaf): PaneSplit {
  const count = collectPaneIds(row).length;
  return {
    type: 'split',
    direction: 'horizontal',
    ratio: count / (count + 1),
    children: [row, leaf]
  };
}

/** A new row takes an even share of the height. */
function addRow(root: PaneNode, leaf: PaneLeaf): PaneSplit {
  const count = rowCount(root);
  return {
    type: 'split',
    direction: 'vertical',
    ratio: count / (count + 1),
    children: [root, leaf]
  };
}

function addLeaf(root: PaneNode | null, leaf: PaneLeaf): PaneNode {
  if (!root) return leaf;
  const lastRow = isRows(root) ? root.children[1] : root;
  if (collectPaneIds(lastRow).length >= PANES_IN_ROW) return addRow(root, leaf);
  if (!isRows(root)) return addToRow(root, leaf);
  return { ...root, children: [root.children[0], addToRow(lastRow, leaf)] };
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
