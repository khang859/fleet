// src/renderer/src/components/Telescope/modes/files-mode.ts
import { File } from 'lucide-react';
import { fuzzyMatch } from '../../../lib/commands';
import { getFileIcon } from '../../../lib/file-icons';
import { quotePathForShell, bracketedPaste } from '../../../lib/shell-utils';
import { useWorkspaceStore } from '../../../store/workspace-store';
import type { TelescopeMode, TelescopeItem } from '../types';

type FileEntry = {
  path: string;
  relativePath: string;
  name: string;
};

/** Module-level cache: cwd → file listing */
const fileCache = new Map<string, FileEntry[]>();

function makeItem(file: FileEntry): TelescopeItem {
  return {
    id: file.path,
    icon: getFileIcon(file.name),
    title: file.name,
    subtitle: file.relativePath,
    data: { filePath: file.path }
  };
}

export function createFilesMode(cwd: string, activePaneId: string | null): TelescopeMode {
  // Pre-load file listing in the background
  if (!fileCache.has(cwd)) {
    void window.fleet.file.list(cwd).then((result) => {
      fileCache.set(cwd, result.files);
    });
  }

  return {
    id: 'files',
    label: 'Files',
    icon: File,
    placeholder: 'Search files by name...',

    onSearch: async (query: string): Promise<TelescopeItem[]> => {
      if (!query) {
        // Return recent files (first 15)
        const recentFiles = useWorkspaceStore.getState().recentFiles.slice(0, 15);
        return recentFiles.map((filePath) => {
          const name = filePath.split('/').pop() ?? filePath;
          return {
            id: filePath,
            icon: getFileIcon(name),
            title: name,
            subtitle: filePath,
            data: { filePath }
          };
        });
      }

      // Ensure cache is populated (may have been set by pre-load)
      let files = fileCache.get(cwd);
      if (!files) {
        const result = await window.fleet.file.list(cwd);
        fileCache.set(cwd, result.files);
        files = result.files;
      }

      return files
        .filter((f) => fuzzyMatch(query, f.relativePath) || fuzzyMatch(query, f.name))
        .slice(0, 50)
        .map(makeItem);
    },

    onSelect: (item) => {
      const filePath = item.data?.filePath;
      if (typeof filePath !== 'string') return;
      useWorkspaceStore.getState().openFile(filePath);
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

    renderPreview: () => null
  };
}
