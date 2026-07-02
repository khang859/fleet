import type { Tab, PaneLeaf, PaneNode, ActivityState } from '../../../shared/types';
import { collectPaneIds, cwdBasename } from '../store/workspace-store';

export type PaletteSection = 'needs-you' | 'recent' | 'command' | 'destination';

export type PaletteItem = {
  id: string;
  label: string;
  section: PaletteSection;
  keywords?: string[];
  /** Pre-formatted shortcut string for the right-aligned kbd chip. */
  shortcutLabel?: string;
  /** Small status pill, e.g. 'needs you'. */
  badge?: string;
  /** When true, Cmd+K / ArrowRight on this row opens its scoped action panel. */
  hasActions?: boolean;
  run: () => void;
};

export type PaneLocation = { tabId: string; tab: Tab; leaf: PaneLeaf };

export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null;
  return findLeaf(node.children[0], paneId) ?? findLeaf(node.children[1], paneId);
}

export function findPaneLocation(tabs: Tab[], paneId: string): PaneLocation | null {
  for (const tab of tabs) {
    if (collectPaneIds(tab.splitRoot).includes(paneId)) {
      const leaf = findLeaf(tab.splitRoot, paneId);
      if (leaf) return { tabId: tab.id, tab, leaf };
    }
  }
  return null;
}

export function paneLabel(loc: PaneLocation): string {
  if (loc.leaf.label?.trim()) return loc.leaf.label;
  return cwdBasename(loc.leaf.cwd, loc.leaf.pathContext);
}

export function selectNeedsMePaneIds(activities: Map<string, { state: ActivityState }>): string[] {
  const ids: string[] = [];
  for (const [paneId, rec] of activities) {
    if (rec.state === 'needs_me') ids.push(paneId);
  }
  return ids;
}
