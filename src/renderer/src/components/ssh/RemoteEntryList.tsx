import { forwardRef } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Folder,
  Link2,
  Copy,
  ExternalLink,
  FolderOpen,
  PenLine,
  Trash2
} from 'lucide-react';
import type { RemoteDirEntry } from '../../../../shared/remote-ssh-types';
import { getFileIcon } from '../../lib/file-icons';
import { popperAnim } from '../../lib/motion';
import type { SortDir, SortKey, ViewMode } from '../../store/remote-ssh-store';

const itemClass =
  'flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3';

function formatSize(entry: RemoteDirEntry): string {
  if (entry.kind === 'dir') return '-';
  const n = entry.size;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Absolute date, day-precision - file lists are scanned, and a stable column
 *  scans far better than "3 days ago" strings of varying width. */
function formatMtime(mtimeMs: number): string {
  if (!mtimeMs) return '-';
  const d = new Date(mtimeMs);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  });
  return sameYear
    ? `${date}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : date;
}

function entryIcon(entry: RemoteDirEntry): React.ReactNode {
  if (entry.kind === 'dir') return <Folder size={13} className="text-sky-400" />;
  if (entry.kind === 'symlink') return <Link2 size={13} className="text-teal-400" />;
  return getFileIcon(entry.name);
}

type RowActions = {
  onOpen: (entry: RemoteDirEntry) => void;
  onCopyPath: (entry: RemoteDirEntry) => void;
  onDownload: (entry: RemoteDirEntry) => void;
  onRename: (entry: RemoteDirEntry) => void;
  onDelete: (entry: RemoteDirEntry) => void;
};

type Props = RowActions & {
  entries: RemoteDirEntry[];
  view: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;
  focused: string | null;
  onFocus: (path: string) => void;
  onSort: (key: SortKey) => void;
};

export const RemoteEntryList = forwardRef<HTMLDivElement, Props>(function RemoteEntryList(
  {
    entries,
    view,
    sortKey,
    sortDir,
    focused,
    onFocus,
    onSort,
    onOpen,
    onCopyPath,
    onDownload,
    onRename,
    onDelete
  },
  ref
) {
  const rows = entries.map((entry) => {
    const isFocused = entry.path === focused;
    const body =
      view === 'grid' ? (
        <button
          className={`flex flex-col items-center gap-1.5 p-2 rounded w-full text-center transition-colors ${
            isFocused ? 'bg-teal-500/15 ring-1 ring-teal-500/40' : 'hover:bg-white/5'
          }`}
          data-focused={isFocused}
          onClick={() => onFocus(entry.path)}
          onDoubleClick={() => onOpen(entry)}
        >
          <span className="scale-[2] py-2 text-neutral-400">{entryIcon(entry)}</span>
          <span className="text-xs text-neutral-300 truncate w-full" title={entry.name}>
            {entry.name}
          </span>
        </button>
      ) : (
        <button
          className={`flex items-center gap-2 w-full px-3 h-7 text-left transition-colors ${
            isFocused ? 'bg-teal-500/15' : 'hover:bg-white/5'
          }`}
          data-focused={isFocused}
          onClick={() => onFocus(entry.path)}
          onDoubleClick={() => onOpen(entry)}
        >
          <span className="shrink-0 text-neutral-400">{entryIcon(entry)}</span>
          <span className="flex-1 min-w-0 truncate text-xs text-neutral-200" title={entry.path}>
            {entry.name}
          </span>
          <span className="w-20 shrink-0 text-right text-xs text-neutral-500 tabular-nums">
            {formatSize(entry)}
          </span>
          <span className="w-32 shrink-0 text-right text-xs text-neutral-500 tabular-nums">
            {formatMtime(entry.mtimeMs)}
          </span>
        </button>
      );

    return (
      <ContextMenu.Root key={entry.path}>
        <ContextMenu.Trigger asChild onContextMenu={() => onFocus(entry.path)}>
          {body}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className={`min-w-[180px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 text-sm text-fleet-text z-50 ${popperAnim}`}
          >
            <ContextMenu.Item className={itemClass} onSelect={() => onOpen(entry)}>
              {entry.kind === 'dir' ? <FolderOpen size={14} /> : <ExternalLink size={14} />}
              {entry.kind === 'dir' ? 'Open folder' : 'Open'}
            </ContextMenu.Item>
            {entry.kind !== 'dir' && (
              <ContextMenu.Item className={itemClass} onSelect={() => onDownload(entry)}>
                <ArrowDownToLine size={14} />
                Download…
              </ContextMenu.Item>
            )}
            <ContextMenu.Separator className="my-1 h-px bg-fleet-surface-3" />
            <ContextMenu.Item className={itemClass} onSelect={() => onCopyPath(entry)}>
              <Copy size={14} />
              Copy path
            </ContextMenu.Item>
            <ContextMenu.Item className={itemClass} onSelect={() => onRename(entry)}>
              <PenLine size={14} />
              Rename…
            </ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-fleet-surface-3" />
            {/* Destructive action last and visually separated, so it is never
                adjacent to the item a user reaches for by muscle memory. */}
            <ContextMenu.Item
              className={`${itemClass} text-red-400 focus:bg-red-500/15 hover:bg-red-500/15`}
              onSelect={() => onDelete(entry)}
            >
              <Trash2 size={14} />
              Delete…
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    );
  });

  if (view === 'grid') {
    return (
      <div
        ref={ref}
        tabIndex={0}
        className="flex-1 min-h-0 overflow-y-auto outline-none p-2 grid gap-1 [grid-template-columns:repeat(auto-fill,minmax(6.5rem,1fr))]"
      >
        {rows}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Column header - sortable, matching Baymard's guidance that spec-dense
          items belong in a list where the specs line up into scannable columns. */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 h-6 border-b border-neutral-800 bg-neutral-950/40 text-[11px] text-neutral-500 select-none">
        <span className="w-[13px] shrink-0" />
        <SortHeader
          className="flex-1 min-w-0"
          label="Name"
          active={sortKey === 'name'}
          dir={sortDir}
          onClick={() => onSort('name')}
        />
        <SortHeader
          className="w-20 shrink-0 justify-end"
          label="Size"
          active={sortKey === 'size'}
          dir={sortDir}
          onClick={() => onSort('size')}
        />
        <SortHeader
          className="w-32 shrink-0 justify-end"
          label="Modified"
          active={sortKey === 'modified'}
          dir={sortDir}
          onClick={() => onSort('modified')}
        />
      </div>
      <div ref={ref} tabIndex={0} className="flex-1 min-h-0 overflow-y-auto outline-none py-1">
        {rows}
      </div>
    </div>
  );
});

function SortHeader({
  label,
  active,
  dir,
  onClick,
  className
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  className: string;
}): React.JSX.Element {
  return (
    <button
      className={`flex items-center gap-1 hover:text-neutral-300 transition-colors ${active ? 'text-neutral-300' : ''} ${className}`}
      onClick={onClick}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}
      {active &&
        (dir === 'asc' ? (
          <ArrowUp size={10} className="shrink-0" />
        ) : (
          <ArrowDown size={10} className="shrink-0" />
        ))}
    </button>
  );
}
