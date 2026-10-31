import type { PaneNode } from '../../../shared/types';

export function collectPaneIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return [...collectPaneIds(node.children[0]), ...collectPaneIds(node.children[1])];
}
