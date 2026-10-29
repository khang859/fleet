// src/renderer/src/components/Telescope/modes/browse-mode.ts
import { createElement } from 'react';
import { Folder, FolderOpen } from 'lucide-react';
import { fuzzyMatch } from '../../../lib/commands';
import { getFileIcon } from '../../../lib/file-icons';
import { quotePathForShell, bracketedPaste } from '../../../lib/shell-utils';
import { useWorkspaceStore, getPaneContextById } from '../../../store/workspace-store';
import { pathForPaneContext } from '../../../../../shared/path-platform';
import type { BrowseDir } from '../use-browse-dir';
import type { TelescopeMode, TelescopeItem } from '../types';

/** Browse filters what is already loaded, so its search is synchronous. */
export type BrowseMode = Omit<TelescopeMode, 'onSearch'> & {
  onSearch: (query: string) => TelescopeItem[];
};

/** Builds the Browse mode from a `useBrowseDir` snapshot. Holds no state of its own. */
export function createBrowseMode(browse: BrowseDir, activePaneId: string | null): BrowseMode {
  const ctx = getPaneContextById(activePaneId);

  return {
    id: 'browse',
    label: 'Browse',
    icon: FolderOpen,
    placeholder: 'Filter current directory...',
    crumbs: browse.crumbs,
    onNavigate: browse.navigate,
    onNavigateUp: browse.navigateUp,

    onSearch: (query: string): TelescopeItem[] => {
      const entries = query
        ? browse.entries.filter((e) => fuzzyMatch(query, e.name))
        : browse.entries;

      return entries.map(
        (entry): TelescopeItem => ({
          id: entry.path,
          icon: entry.isDirectory
            ? createElement(Folder, { size: 14, className: 'text-blue-400' })
            : getFileIcon(entry.name),
          title: entry.name,
          data: {
            filePath: entry.path,
            isDirectory: entry.isDirectory,
            isIgnored: browse.ignoredNames.has(entry.name) || entry.name === '.git'
          }
        })
      );
    },

    onSelect: (item) => {
      const filePath = item.data?.filePath;
      const isDirectory = item.data?.isDirectory;
      if (typeof filePath !== 'string') return;
      if (isDirectory === true) {
        browse.navigate(filePath);
      } else {
        useWorkspaceStore.getState().openFile(filePath, ctx);
      }
    },

    onAltSelect: (item) => {
      const filePath = item.data?.filePath;
      if (typeof filePath !== 'string' || !activePaneId) return;
      const quoted = quotePathForShell(pathForPaneContext(filePath, ctx), ctx);
      window.fleet.pty.input({
        paneId: activePaneId,
        data: bracketedPaste(quoted + ' ')
      });
    },

    renderPreview: () => null
  };
}
