import { useRef, useState, useEffect } from 'react';

function quotePathForShell(filePath: string, platform: string): string {
  if (platform === 'win32') {
    return '"' + filePath.replace(/"/g, '\\"') + '"';
  }
  // POSIX: single-quote, escape internal single quotes as '\''
  return "'" + filePath.replace(/'/g, "'\\''") + "'";
}

function formatDroppedFiles(files: FileList, platform: string): string {
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const filePath = window.fleet.utils.getFilePath(files[i]);
    paths.push(quotePathForShell(filePath, platform));
  }
  return paths.join(' ') + ' ';
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
    const resetDrag = () => {
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

      if (e.dataTransfer.files.length > 0) {
        const formatted = formatDroppedFiles(e.dataTransfer.files, window.fleet.platform);
        window.fleet.pty.input({ paneId, data: formatted });
        onAfterDrop?.();
      }
    }
  };

  return { isDragOver, handlers };
}
