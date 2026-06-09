// src/renderer/src/components/sessions/tree-utils.ts
// Pure helpers for navigating a Rune session's branch graph.
import type { SessionTree, SessionTreeNode, TranscriptMessage } from '../../../../shared/sessions';

/** Map of node id -> node for a tree. */
function indexById(tree: SessionTree): Map<string, SessionTreeNode> {
  return new Map(tree.nodes.map((n) => [n.id, n]));
}

/** Ids on the path root -> nodeId (inclusive), walking parentId links upward. */
export function pathIds(tree: SessionTree, nodeId: string | null): Set<string> {
  const byId = indexById(tree);
  const ids = new Set<string>();
  let current = nodeId ? byId.get(nodeId) : undefined;
  while (current && !ids.has(current.id)) {
    ids.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return ids;
}

/** Messages on the path root -> nodeId, in chronological order. */
export function pathToNode(tree: SessionTree, nodeId: string | null): TranscriptMessage[] {
  const byId = indexById(tree);
  const chain: SessionTreeNode[] = [];
  const guard = new Set<string>();
  let current = nodeId ? byId.get(nodeId) : undefined;
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain.reverse().map((n) => ({ role: n.role, blocks: n.blocks, createdAt: n.createdAt }));
}

export type TreeRow = {
  node: SessionTreeNode;
  /** One entry per ancestor column (excluding the root): true = draw a vertical bar. */
  ancestorBars: boolean[];
  /** Whether this node is the last among its siblings. */
  isLast: boolean;
  /** Top-level node (hangs off the omitted root); rendered without an elbow connector. */
  isRoot: boolean;
};

/** Depth-first pre-order flattening with the connector metadata each row needs to render. */
export function flattenTree(tree: SessionTree): TreeRow[] {
  const byId = indexById(tree);
  const childrenOf = (n: SessionTreeNode): SessionTreeNode[] =>
    n.childIds.map((id) => byId.get(id)).filter((x): x is SessionTreeNode => Boolean(x));
  const roots = tree.nodes.filter((n) => n.parentId === null);
  const rows: TreeRow[] = [];
  const visited = new Set<string>();

  const visit = (
    node: SessionTreeNode,
    ancestorBars: boolean[],
    isLast: boolean,
    isRoot: boolean
  ): void => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    rows.push({ node, ancestorBars, isLast, isRoot });
    // The root occupies column 0 with its dot, so it contributes no bar column; its
    // children connect directly beneath it. Deeper nodes add a bar that continues
    // downward only while the current node still has a following sibling.
    const childBars = isRoot ? ancestorBars : [...ancestorBars, !isLast];
    const kids = childrenOf(node);
    kids.forEach((kid, i) => visit(kid, childBars, i === kids.length - 1, false));
  };

  roots.forEach((r, i) => visit(r, [], i === roots.length - 1, true));
  return rows;
}
