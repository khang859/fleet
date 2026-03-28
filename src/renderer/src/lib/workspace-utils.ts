import { useCwdStore } from '../store/cwd-store';
import type { PaneNode, PaneLeaf } from '../../../shared/types';

export function injectLiveCwd(node: PaneNode): PaneNode {
  const cwds = useCwdStore.getState().cwds;
  if (node.type === 'leaf') {
    const liveCwd = cwds.get(node.id);
    return liveCwd ? { ...node, cwd: liveCwd } : node;
  }
  return {
    ...node,
    children: [injectLiveCwd(node.children[0]), injectLiveCwd(node.children[1])]
  };
}

/** Get the live CWD of the first pane leaf in a tree, for updating the tab-level cwd. */
export function getFirstPaneLiveCwd(node: PaneNode): string | undefined {
  const cwds = useCwdStore.getState().cwds;
  function findFirst(n: PaneNode): PaneLeaf | null {
    if (n.type === 'leaf') return n;
    return findFirst(n.children[0]) ?? findFirst(n.children[1]);
  }
  const leaf = findFirst(node);
  return leaf ? cwds.get(leaf.id) : undefined;
}
