import { useCwdStore } from '../store/cwd-store';
import type { PaneNode } from '../../../shared/types';

export function injectLiveCwd(node: PaneNode): PaneNode {
  const cwds = useCwdStore.getState().cwds;
  if (node.type === 'leaf') {
    const liveCwd = cwds.get(node.id);
    return liveCwd ? { ...node, cwd: liveCwd } : node;
  }
  return {
    ...node,
    children: [
      injectLiveCwd(node.children[0]),
      injectLiveCwd(node.children[1]),
    ],
  };
}
