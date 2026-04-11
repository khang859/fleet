// src/renderer/src/components/Telescope/modes/browse-mode.ts
import { createElement } from 'react';
import { Folder, FolderOpen } from 'lucide-react';
import { fuzzyMatch } from '../../../lib/commands';
import { getFileIcon } from '../../../lib/file-icons';
import { quotePathForShell, bracketedPaste } from '../../../lib/shell-utils';
import { useWorkspaceStore } from '../../../store/workspace-store';
import type { DirEntry } from '../../../../../shared/ipc-api';
import type { TelescopeMode, TelescopeItem } from '../types';

type BrowseState = {
  currentDir: string;
  entries: DirEntry[];
  loading: boolean;
};

export function createBrowseMode(
  cwd: string,
  activePaneId: string | null,
  onStateChange: () => void
): TelescopeMode & { getState: () => BrowseState } {
  const state: BrowseState = {
    currentDir: cwd,
    entries: [],
    loading: false
  };

  async function loadDir(dir: string): Promise<void> {
    state.currentDir = dir;
    state.loading = true;
    onStateChange();

    const result = await window.fleet.file.readdir(dir);
    if (result.success) {
      // Sort: directories first, then alphabetical within each group
      state.entries = [...result.entries].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
    } else {
      state.entries = [];
    }

    state.loading = false;
    onStateChange();
  }

  // Initial load
  void loadDir(cwd);

  const mode: TelescopeMode & { getState: () => BrowseState } = {
    id: 'browse',
    label: 'Browse',
    icon: FolderOpen,
    placeholder: 'Filter current directory...',

    get breadcrumbs(): string[] {
      const dir = state.currentDir;
      const homeDir = window.fleet.homeDir;
      if (dir.startsWith(homeDir)) {
        const relative = dir.slice(homeDir.length);
        const parts = relative.split('/').filter(Boolean);
        return ['~', ...parts];
      }
      return dir.split('/').filter(Boolean);
    },

    onNavigate: (dir: string) => {
      void loadDir(dir);
    },

    onNavigateUp: () => {
      const parent = state.currentDir.split('/').slice(0, -1).join('/') || '/';
      void loadDir(parent);
    },

    onSearch: (query: string): TelescopeItem[] => {
      const entries = query
        ? state.entries.filter((e) => fuzzyMatch(query, e.name))
        : state.entries;

      return entries.map(
        (entry): TelescopeItem => ({
          id: entry.path,
          icon: entry.isDirectory
            ? createElement(Folder, { size: 14, className: 'text-blue-400' })
            : getFileIcon(entry.name),
          title: entry.name,
          subtitle: entry.isDirectory ? 'Directory' : undefined,
          data: { filePath: entry.path, isDirectory: entry.isDirectory }
        })
      );
    },

    onSelect: (item) => {
      const filePath = item.data?.filePath;
      const isDirectory = item.data?.isDirectory;
      if (typeof filePath !== 'string') return;
      if (isDirectory === true) {
        void loadDir(filePath);
      } else {
        useWorkspaceStore.getState().openFile(filePath);
      }
    },

    onAltSelect: (item) => {
      const filePath = item.data?.filePath;
      if (typeof filePath !== 'string' || !activePaneId) return;
      const quoted = quotePathForShell(filePath, window.fleet.platform);
      window.fleet.pty.input({
        paneId: activePaneId,
        data: bracketedPaste(quoted + ' ')
      });
    },

    renderPreview: () => null,

    getState: () => state
  };

  return mode;
}
