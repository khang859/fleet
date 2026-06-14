import { useRef, useState, useEffect } from 'react';
import { quotePathForShell } from '../lib/shell-utils';
import { getPaneContextById } from '../store/workspace-store';
import { pathForPaneContext } from '../../../shared/path-platform';
import type { PathContext } from '../../../shared/shell-profiles';

/**
 * getFilePath returns a Windows path. For a WSL pane translate it to POSIX via
 * wslpath (cached, honours a custom automount.root); the pure heuristic is the
 * fallback if the subprocess fails. win32/posix panes pass through.
 */
async function pathForContext(winPath: string, ctx: PathContext): Promise<string> {
  if (typeof ctx === 'object' && ctx.kind === 'wsl') {
    try {
      return await window.fleet.wsl.toWslPath(ctx.distro, winPath);
    } catch {
      return pathForPaneContext(winPath, ctx);
    }
  }
  return pathForPaneContext(winPath, ctx);
}

async function formatDroppedPaths(winPaths: string[], ctx: PathContext): Promise<string> {
  const quoted = await Promise.all(
    winPaths.map(async (winPath) => quotePathForShell(await pathForContext(winPath, ctx), ctx))
  );
  return quoted.join(' ') + ' ';
}

type TerminalDropHandlers = {
  onDragOver: (e: React.DragEvent) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
};

export function useTerminalDrop(
  paneId: string | null | undefined,
  onAfterDrop?: () => void
): {
  isDragOver: boolean;
  handlers: TerminalDropHandlers;
} {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Safety net: reset drag state on document-level drop/dragend to prevent stuck overlay
  useEffect(() => {
    const resetDrag = (): void => {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    };
    document.addEventListener('drop', resetDrag);
    document.addEventListener('dragend', resetDrag);
    return () => {
      document.removeEventListener('drop', resetDrag);
      document.removeEventListener('dragend', resetDrag);
    };
  }, []);

  if (!paneId) {
    return {
      isDragOver: false,
      handlers: {
        onDragOver: () => {},
        onDragEnter: () => {},
        onDragLeave: () => {},
        onDrop: () => {}
      }
    };
  }

  const handlers: TerminalDropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault();
      if (!e.dataTransfer.types.includes('Files')) return;
      dragCounterRef.current++;
      if (dragCounterRef.current === 1) {
        setIsDragOver(true);
      }
    },
    onDragLeave: () => {
      dragCounterRef.current--;
      if (dragCounterRef.current === 0) {
        setIsDragOver(false);
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragOver(false);

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        // Capture Windows paths synchronously before any await (the synthetic
        // event and its FileList are pooled/reused after the handler returns).
        const winPaths: string[] = [];
        for (let i = 0; i < files.length; i++) {
          winPaths.push(window.fleet.utils.getFilePath(files[i]));
        }
        const ctx = getPaneContextById(paneId);
        void formatDroppedPaths(winPaths, ctx).then((formatted) => {
          window.fleet.pty.input({ paneId, data: formatted });
          onAfterDrop?.();
        });
      }
    }
  };

  return { isDragOver, handlers };
}
