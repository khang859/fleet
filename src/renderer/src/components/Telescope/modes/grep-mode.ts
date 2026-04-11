// src/renderer/src/components/Telescope/modes/grep-mode.ts
import { createElement } from 'react';
import { TextSearch } from 'lucide-react';
import { bracketedPaste } from '../../../lib/shell-utils';
import { useWorkspaceStore } from '../../../store/workspace-store';
import type { TelescopeMode, TelescopeItem } from '../types';

export function createGrepMode(cwd: string, activePaneId: string | null): TelescopeMode {
  let requestCounter = 0;

  return {
    id: 'grep',
    label: 'Grep',
    icon: TextSearch,
    placeholder: 'Search file contents...',

    onSearch: async (query: string): Promise<TelescopeItem[]> => {
      if (!query) return [];

      const myRequest = ++requestCounter;
      const requestId = myRequest;

      const response = await window.fleet.file.grep({ requestId, query, cwd, limit: 50 });

      // Discard stale responses
      if (myRequest !== requestCounter) return [];

      if (!response.success) return [];

      return response.results.map((result) => ({
        id: `${result.file}:${result.line}`,
        icon: createElement(
          'span',
          { style: { fontFamily: 'monospace', fontSize: '11px', opacity: 0.7 } },
          String(result.line)
        ),
        title: result.relativePath,
        subtitle: result.text.trim(),
        meta: `L${result.line}`,
        data: {
          filePath: result.file,
          line: result.line,
          contextBefore: result.contextBefore,
          contextAfter: result.contextAfter
        }
      }));
    },

    onSelect: (item) => {
      const filePath = item.data?.filePath as string | undefined;
      if (!filePath) return;
      useWorkspaceStore.getState().openFile(filePath);
    },

    onAltSelect: (item) => {
      const filePath = item.data?.filePath as string | undefined;
      const line = item.data?.line as number | undefined;
      if (!filePath || !activePaneId) return;
      const ref = line != null ? `${filePath}:${line}` : filePath;
      window.fleet.pty.input({
        paneId: activePaneId,
        data: bracketedPaste(ref)
      });
    },

    renderPreview: () => null
  };
}
