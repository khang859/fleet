import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpFromLine,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  List,
  Loader2,
  RefreshCw,
  ServerCrash,
  Upload
} from 'lucide-react';
import type {
  RemoteDirEntry,
  RemoteHost,
  RemoteTransfer
} from '../../../../shared/remote-ssh-types';
import { isBinaryBlockedFilePath } from '../../../../shared/file-open';
import { remoteChildPath } from '../../lib/remote-names';
import { useRemoteSshStore } from '../../store/remote-ssh-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { useToastStore } from '../../store/toast-store';
import { RemoteBreadcrumbs } from './RemoteBreadcrumbs';
import { RemoteDeleteDialog } from './RemoteDeleteDialog';
import { RemoteEntryList } from './RemoteEntryList';
import { RemoteNameDialog, type NameRequest } from './RemoteNameDialog';
import { TransferStrip } from './TransferStrip';

type Props = {
  paneId: string;
  host: RemoteHost;
  initialPath?: string;
};

/** The one open dialog, if any. Only one can be up at a time by construction. */
type PaneDialog =
  | { kind: 'new-folder' }
  | { kind: 'rename'; entry: RemoteDirEntry }
  | { kind: 'delete'; entry: RemoteDirEntry };

function isTransfer(t: RemoteTransfer | undefined): t is RemoteTransfer {
  return t !== undefined;
}

export function SshBrowserPane({ paneId, host, initialPath }: Props): React.JSX.Element {
  const pane = useRemoteSshStore((s) => s.panes[paneId]);
  const openPane = useRemoteSshStore((s) => s.openPane);
  const closePane = useRemoteSshStore((s) => s.closePane);
  const navigate = useRemoteSshStore((s) => s.navigate);
  const refresh = useRemoteSshStore((s) => s.refresh);
  const goUp = useRemoteSshStore((s) => s.goUp);
  const goBack = useRemoteSshStore((s) => s.goBack);
  const goForward = useRemoteSshStore((s) => s.goForward);
  const setSort = useRemoteSshStore((s) => s.setSort);
  const setView = useRemoteSshStore((s) => s.setView);
  const setFocused = useRemoteSshStore((s) => s.setFocused);

  const createFolder = useRemoteSshStore((s) => s.createFolder);
  const renameEntry = useRemoteSshStore((s) => s.renameEntry);
  const removeEntry = useRemoteSshStore((s) => s.removeEntry);

  const startTransfer = useRemoteSshStore((s) => s.startTransfer);
  const cancelTransfer = useRemoteSshStore((s) => s.cancelTransfer);
  const dismissTransfer = useRemoteSshStore((s) => s.dismissTransfer);
  const allTransfers = useRemoteSshStore((s) => s.transfers);

  const openRemoteFile = useWorkspaceStore((s) => s.openRemoteFile);
  const showToast = useToastStore((s) => s.show);
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<PaneDialog | null>(null);

  const transfers = useMemo(
    () =>
      Object.values(allTransfers)
        .filter((t) => t?.paneId === paneId)
        .filter(isTransfer),
    [allTransfers, paneId]
  );

  useEffect(() => {
    void openPane(paneId, host, initialPath);
    return () => closePane(paneId);
    // Re-opening on host/path identity change is intentional; the pane is keyed
    // by paneId and a different target is a different browsing session.
  }, [paneId, host, initialPath, openPane, closePane]);

  const handleOpen = useCallback(
    (entry: RemoteDirEntry) => {
      // Symlinks resolve server-side: `list`/`stat` follow them, so a link to a
      // directory simply lists as that directory.
      if (entry.kind === 'dir') {
        void navigate(paneId, entry.path);
        return;
      }
      if (isBinaryBlockedFilePath(entry.path)) {
        showToast(`Can't preview ${entry.name}`);
        return;
      }
      openRemoteFile(host, entry.path);
    },
    [paneId, host, navigate, openRemoteFile, showToast]
  );

  const handleCopyPath = useCallback(
    (entry: RemoteDirEntry) => {
      void navigator.clipboard.writeText(entry.path).then(() => showToast('Copied path'));
    },
    [showToast]
  );

  const handleDownload = useCallback(
    async (entry: RemoteDirEntry) => {
      const localPath = await window.fleet.file.saveDialog({ defaultName: entry.name });
      if (!localPath) return;
      await startTransfer('download', { paneId, host, localPath, remotePath: entry.path });
    },
    [paneId, host, startTransfer]
  );

  const uploadFiles = useCallback(
    async (localPaths: string[]) => {
      if (!pane) return;
      // Sequential rather than parallel: several transfers over one multiplexed
      // connection just share the same pipe, and one bar at a time is far
      // easier to read than five racing each other.
      for (const localPath of localPaths) {
        const name = localPath.split(/[\\/]/).pop() ?? localPath;
        await startTransfer('upload', {
          paneId,
          host,
          localPath,
          remotePath: remoteChildPath(pane.cwd, name)
        });
      }
    },
    [pane, paneId, host, startTransfer]
  );

  const handleUploadClick = useCallback(async () => {
    const picked = await window.fleet.file.openDialog({ multi: true });
    if (picked.length > 0) await uploadFiles(picked);
  }, [uploadFiles]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      // Electron exposes the real filesystem path of a dropped file here; a drop
      // from another app that carries no path is silently ignored rather than
      // uploading an empty file.
      const paths = Array.from(e.dataTransfer.files)
        .map((file) => window.fleet.utils.getFilePath(file))
        .filter((path) => path.length > 0);
      if (paths.length > 0) void uploadFiles(paths);
    },
    [uploadFiles]
  );

  const nameRequest: NameRequest | null = useMemo(() => {
    if (dialog?.kind === 'new-folder') {
      return {
        title: 'New folder',
        label: `Created in ${pane?.cwd ?? ''}`,
        initialValue: '',
        confirmLabel: 'Create'
      };
    }
    if (dialog?.kind === 'rename') {
      return {
        title: 'Rename',
        label: 'New name',
        initialValue: dialog.entry.name,
        confirmLabel: 'Rename'
      };
    }
    return null;
  }, [dialog, pane?.cwd]);

  const submitName = useCallback(
    async (value: string): Promise<string | null> => {
      if (dialog?.kind === 'new-folder') return createFolder(paneId, value);
      if (dialog?.kind === 'rename') return renameEntry(paneId, dialog.entry, value);
      return null;
    },
    [dialog, paneId, createFolder, renameEntry]
  );

  const confirmDelete = useCallback(async (): Promise<string | null> => {
    if (dialog?.kind !== 'delete') return null;
    return removeEntry(paneId, dialog.entry);
  }, [dialog, paneId, removeEntry]);

  // Keyboard navigation over the visible (already sorted) rows.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!pane) return;
      const { entries, focused } = pane;
      const index = entries.findIndex((entry) => entry.path === focused);

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (entries.length === 0) return;
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const next = Math.min(entries.length - 1, Math.max(0, index + delta));
        setFocused(paneId, entries[next].path);
        return;
      }
      if (e.key === 'Enter' && index >= 0) {
        e.preventDefault();
        handleOpen(entries[index]);
        return;
      }
      // ⌘⌫ is the Finder gesture for delete, and it opens the same confirmation
      // the menu item does - the shortcut is a faster route, never a quieter one.
      if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (index >= 0) setDialog({ kind: 'delete', entry: entries[index] });
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        void goUp(paneId);
      }
    },
    [pane, paneId, setFocused, handleOpen, goUp]
  );

  // Keep the focused row in view as the arrow keys walk past the viewport edge.
  useEffect(() => {
    if (!pane?.focused) return;
    const el = listRef.current?.querySelector('[data-focused="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [pane?.focused]);

  if (!pane) {
    return (
      <div className="h-full w-full flex items-center justify-center gap-2 bg-neutral-900 text-neutral-400 text-sm">
        <Loader2 className="animate-spin" size={16} />
        Connecting to {host.label}…
      </div>
    );
  }

  const canBack = pane.historyIndex > 0;
  const canForward = pane.historyIndex < pane.history.length - 1;

  return (
    <div
      className="relative flex flex-col h-full w-full bg-neutral-900 outline-none"
      onKeyDown={handleKeyDown}
      onDragOver={(e) => {
        // Only files upload, so only a file drag lights the pane up. Dragging a
        // tab or a text selection across it must not offer to send it anywhere.
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves the pane, not when it
        // crosses between children, which fire dragleave on the way past.
        const entering = e.relatedTarget;
        if (!(entering instanceof Node) || !e.currentTarget.contains(entering)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      {/* Toolbar: navigation on the left, view controls on the right */}
      <div className="flex-shrink-0 flex items-center gap-1 px-2 h-8 border-b border-neutral-800 bg-neutral-950/60">
        <ToolbarButton onClick={() => void goBack(paneId)} title="Back" disabled={!canBack}>
          <ArrowLeft size={13} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => void goForward(paneId)}
          title="Forward"
          disabled={!canForward}
        >
          <ArrowRight size={13} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => void goUp(paneId)}
          title="Parent folder"
          disabled={pane.cwd === '/'}
        >
          <ArrowUpFromLine size={13} />
        </ToolbarButton>
        <ToolbarButton onClick={() => void refresh(paneId)} title="Refresh">
          <RefreshCw size={13} className={pane.loading ? 'animate-spin' : ''} />
        </ToolbarButton>

        <div className="w-px h-3.5 bg-neutral-700 mx-1" />

        <div className="flex-1 min-w-0 overflow-hidden">
          <RemoteBreadcrumbs
            hostLabel={host.label}
            path={pane.cwd}
            connected={pane.connection === 'connected'}
            onNavigate={(path) => void navigate(paneId, path)}
          />
        </div>

        <div className="w-px h-3.5 bg-neutral-700 mx-1" />

        <ToolbarButton onClick={() => setDialog({ kind: 'new-folder' })} title="New folder">
          <FolderPlus size={13} />
        </ToolbarButton>
        <ToolbarButton onClick={() => void handleUploadClick()} title="Upload files here">
          <Upload size={13} />
        </ToolbarButton>

        <div className="w-px h-3.5 bg-neutral-700 mx-1" />

        <ToolbarButton
          onClick={() => setView(paneId, 'list')}
          title="List view"
          active={pane.view === 'list'}
        >
          <List size={13} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => setView(paneId, 'grid')}
          title="Grid view"
          active={pane.view === 'grid'}
        >
          <LayoutGrid size={13} />
        </ToolbarButton>
      </div>

      {/* Body */}
      {pane.error !== null ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
          <ServerCrash size={28} className="text-neutral-600" />
          <div className="text-sm text-red-400 max-w-md whitespace-pre-wrap">{pane.error}</div>
          <button
            className="flex items-center gap-1.5 text-xs text-neutral-300 hover:text-white px-2 py-1 rounded hover:bg-white/10 transition-colors active:scale-[0.97]"
            onClick={() => void refresh(paneId)}
          >
            <RefreshCw size={12} />
            Try again
          </button>
        </div>
      ) : pane.loading && pane.entries.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center gap-2 text-neutral-500 text-sm">
          <Loader2 className="animate-spin" size={16} />
          Loading…
        </div>
      ) : pane.entries.length === 0 ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-sm">
          <FolderOpen size={28} className="text-neutral-700" />
          <div className="text-neutral-400">This folder is empty</div>
        </div>
      ) : (
        <RemoteEntryList
          ref={listRef}
          entries={pane.entries}
          view={pane.view}
          sortKey={pane.sortKey}
          sortDir={pane.sortDir}
          focused={pane.focused}
          onFocus={(path) => setFocused(paneId, path)}
          onSort={(key) => setSort(paneId, key)}
          onOpen={handleOpen}
          onCopyPath={handleCopyPath}
          onDownload={(entry) => void handleDownload(entry)}
          onRename={(entry) => setDialog({ kind: 'rename', entry })}
          onDelete={(entry) => setDialog({ kind: 'delete', entry })}
        />
      )}

      <TransferStrip transfers={transfers} onCancel={cancelTransfer} onDismiss={dismissTransfer} />

      {/* Status bar */}
      <div className="flex-shrink-0 flex items-center gap-3 px-3 h-7 bg-neutral-950/80 border-t border-neutral-800 text-xs text-neutral-500">
        <span>
          {pane.entries.length} {pane.entries.length === 1 ? 'item' : 'items'}
        </span>
        <span className="font-mono truncate min-w-0 ml-auto" title={pane.cwd}>
          {pane.cwd}
        </span>
      </div>

      {/* Drop target. Named so the destination is unambiguous before the drop -
          the folder being uploaded into is the one currently open, not the row
          under the cursor. */}
      {dragging && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-neutral-950/80 border-2 border-dashed border-teal-500/60 pointer-events-none">
          <Upload size={28} className="text-teal-400" />
          <div className="text-sm text-neutral-200">Upload to {host.label}</div>
          <div className="text-xs font-mono text-neutral-500">{pane.cwd}</div>
        </div>
      )}

      <RemoteNameDialog
        request={nameRequest}
        onSubmit={submitName}
        onClose={() => setDialog(null)}
      />
      <RemoteDeleteDialog
        entry={dialog?.kind === 'delete' ? dialog.entry : null}
        hostLabel={host.label}
        onConfirm={confirmDelete}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  title,
  disabled,
  active
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
}): React.JSX.Element {
  return (
    <button
      className={`px-1.5 py-1 rounded transition-colors active:scale-[0.97] disabled:opacity-30 disabled:pointer-events-none disabled:active:scale-100 ${
        active
          ? 'bg-white/10 text-neutral-100'
          : 'text-neutral-400 hover:text-white hover:bg-white/10'
      }`}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
