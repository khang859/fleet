import { useRef, useState, useEffect } from 'react';
import { quotePathForShell } from '../lib/shell-utils';
import { remoteChildPath } from '../lib/remote-names';
import { getPaneContextById } from '../store/workspace-store';
import { useRemoteStore } from '../store/remote-store';
import { useRemoteCwdStore } from '../store/remote-cwd-store';
import { useRemoteSshStore } from '../store/remote-ssh-store';
import { useToastStore } from '../store/toast-store';
import { toRemoteHost } from '../../../shared/remote-ssh-types';
import { pathForPaneContext } from '../../../shared/path-platform';
import { isWslContext, type PathContext } from '../../../shared/shell-profiles';

/**
 * getFilePath returns a Windows path. For a WSL pane translate it to POSIX via
 * wslpath (cached, honours a custom automount.root); the pure heuristic is the
 * fallback if the subprocess fails. win32/posix panes pass through.
 */
async function pathForContext(winPath: string, ctx: PathContext): Promise<string> {
  if (isWslContext(ctx)) {
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

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

/**
 * Upload each dropped file into the directory the remote shell is standing in,
 * then type the remote paths at the prompt.
 *
 * The local path a drop carries names a file the far side cannot see, so typing
 * it - which is what a local pane does - is worse than useless there. Uploads run
 * one at a time so the transfer strip reads as a queue rather than a scramble,
 * and each path is typed only after its own bytes have landed.
 */
async function dropOntoRemote(paneId: string, winPaths: string[]): Promise<void> {
  const toast = useToastStore.getState();

  const detected = await window.fleet.remoteSsh.detectHost(paneId);
  if (!detected.success || !detected.data) {
    toast.show('Could not work out which host this pane is connected to.');
    return;
  }

  const cwd = useRemoteCwdStore.getState().cwds.get(paneId);
  if (!cwd) {
    // Guessing the login home would put the file somewhere the user is not
    // looking, which is worse than saying so.
    toast.show(
      "Fleet does not know this shell's folder yet. Install Fleet's shell setup for this host."
    );
    return;
  }

  const host = toRemoteHost(detected.data);
  const store = useRemoteSshStore.getState();

  for (const localPath of winPaths) {
    const remotePath = remoteChildPath(cwd, basename(localPath));
    const ok = await store.startTransfer('upload', { paneId, host, localPath, remotePath });
    if (!ok) return;
    window.fleet.pty.input({
      paneId,
      data: quotePathForShell(remotePath, 'posix') + ' '
    });
  }
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
        if (useRemoteStore.getState().remotes.has(paneId)) {
          void dropOntoRemote(paneId, winPaths).then(() => onAfterDrop?.());
          return;
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
