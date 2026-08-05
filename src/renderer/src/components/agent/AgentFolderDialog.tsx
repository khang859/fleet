import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Bot, ChevronRight, Clock, Folder, FolderOpen, Search } from 'lucide-react';
import { Overlay } from '../Overlay';
import { useWorkspaceStore } from '../../store/workspace-store';
import { fuzzyMatch } from '../../lib/commands';
import { basename } from '../../lib/path-utils';
import { shortenPath } from '../../lib/shorten-path';

type Choice = {
  /** Absolute path this row points at. */
  path: string;
  /** Folder name, shown as the row's title. */
  name: string;
  /** Where the folder lives. Shown under the title on recents, which can come from anywhere. */
  parent?: string;
  /** Recents are grouped above the folder listing and carry a different icon. */
  kind: 'recent' | 'folder';
};

/**
 * Parent of an absolute path, or null at a filesystem root. Tolerates both
 * separators so the same code serves posix homes and `C:\Users\...` alike.
 */
function parentDir(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return null;
  if (idx === 0) return '/';
  const head = trimmed.slice(0, idx);
  // A bare drive letter is not a directory - `C:` has to be spelled `C:\`.
  return /^[A-Za-z]:$/.test(head) ? head + '\\' : head;
}

type AgentFolderDialogProps = {
  open: boolean;
  onCancel: () => void;
  onConfirm: (folderPath: string) => void;
};

/**
 * Asks which folder a new agent should work in. Recent folders are the fast
 * path; the listing underneath starts at the user's home directory so a folder
 * that was never opened before is still a couple of keystrokes away, and
 * "Browse" hands off to the OS picker for anywhere else on disk.
 */
export function AgentFolderDialog({
  open,
  onCancel,
  onConfirm
}: AgentFolderDialogProps): React.JSX.Element {
  const homeDir = window.fleet.homeDir;
  const recentFolders = useWorkspaceStore((s) => s.recentFolders);
  const [dir, setDir] = useState(homeDir);
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [entries, setEntries] = useState<Choice[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Every open starts fresh at home rather than resuming wherever the last
  // session wandered to - the home folder is the one location that means the
  // same thing on macOS, Windows and Linux.
  useEffect(() => {
    if (!open) return;
    setDir(homeDir);
    setFilter('');
    setSelectedIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, homeDir]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.fleet.file.readdir(dir).then((result) => {
      if (cancelled) return;
      setEntries(
        result.success
          ? result.entries
              .filter((e) => e.isDirectory)
              .map((e) => ({ path: e.path, name: e.name, kind: 'folder' as const }))
          : []
      );
    });
    return () => {
      cancelled = true;
    };
  }, [open, dir]);

  const recents: Choice[] = useMemo(
    () =>
      recentFolders
        .filter((folder) => fuzzyMatch(filter, basename(folder)) || fuzzyMatch(filter, folder))
        .slice(0, 5)
        .map((folder) => ({
          path: folder,
          name: basename(folder) || folder,
          parent: shortenPath(parentDir(folder) ?? folder),
          kind: 'recent' as const
        })),
    [recentFolders, filter]
  );

  const folders: Choice[] = useMemo(() => {
    const lower = filter.toLowerCase();
    return (
      entries
        .filter((e) => e.name.toLowerCase().includes(lower))
        // Dotfolders are noise until the user types the dot themselves.
        .filter((e) => filter.startsWith('.') || !e.name.startsWith('.'))
    );
  }, [entries, filter]);

  const choices = useMemo(() => [...recents, ...folders], [recents, folders]);
  // `at` rather than an index, so the type says what is true: there is nothing
  // selected when the filter matches nothing, and every use here guards for it.
  const selected = choices.at(selectedIndex);
  const parent = parentDir(dir);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter, dir]);

  useEffect(() => {
    const child = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    if (child instanceof HTMLElement) child.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, choices]);

  /** Browse into a folder instead of opening it. */
  const enterFolder = useCallback((path: string) => {
    setDir(path);
    setFilter('');
  }, []);

  const browse = useCallback(async () => {
    const picked = await window.fleet.showFolderPicker();
    if (picked) onConfirm(picked);
  }, [onConfirm]);

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, choices.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selected) onConfirm(selected.path);
    } else if (e.key === 'Tab' || e.key === 'ArrowRight') {
      if (!selected) return;
      e.preventDefault();
      enterFolder(selected.path);
    } else if (e.key === 'ArrowLeft' || (e.key === 'Backspace' && filter === '')) {
      if (!parent) return;
      e.preventDefault();
      enterFolder(parent);
    }
  };

  return (
    <Overlay
      open={open}
      onClose={onCancel}
      containerClassName="justify-center"
      panelClassName="mt-[12vh] w-[600px] h-[min(64vh,520px)] flex flex-col bg-fleet-surface border border-fleet-border-strong rounded-xl overflow-hidden"
    >
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg fleet-accent-bg-soft fleet-accent-text">
          <Bot size={18} />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fleet-text">New Agent</h2>
          <p className="text-xs text-fleet-text-muted">
            Choose the folder this agent will work in.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 border-y border-fleet-border bg-fleet-bg/40 px-5 py-2.5">
        <Search size={14} className="shrink-0 text-fleet-text-subtle" />
        <input
          ref={inputRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          placeholder="Search recent and nearby folders..."
          className="flex-1 bg-transparent text-sm text-fleet-text outline-none placeholder:text-fleet-text-subtle"
        />
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {recents.length > 0 && (
          <>
            <GroupLabel>Recent</GroupLabel>
            {recents.map((choice, i) => (
              <Row
                key={`recent-${choice.path}`}
                choice={choice}
                index={i}
                isSelected={i === selectedIndex}
                onHover={setSelectedIndex}
                onEnterFolder={enterFolder}
              />
            ))}
          </>
        )}

        <div className="flex items-center justify-between gap-3 px-5 pb-1 pt-3">
          <GroupLabel inline>{shortenPath(dir)}</GroupLabel>
          {parent && (
            <button
              onClick={() => enterFolder(parent)}
              title="Go to parent folder"
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-fleet-text-subtle transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text-secondary focus-ring"
            >
              <ArrowUp size={11} />
              Up
            </button>
          )}
        </div>

        {folders.length === 0 ? (
          <div className="px-5 py-5 text-sm text-fleet-text-muted">
            {filter ? 'No matching folders here' : 'No subfolders here'}
          </div>
        ) : (
          folders.map((choice, i) => (
            <Row
              key={choice.path}
              choice={choice}
              index={recents.length + i}
              isSelected={recents.length + i === selectedIndex}
              onHover={setSelectedIndex}
              onEnterFolder={enterFolder}
            />
          ))
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-fleet-border px-5 py-3">
        <button
          onClick={() => void browse()}
          className="flex items-center gap-2 rounded-md border border-fleet-border-strong px-3 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 active:scale-[0.98] focus-ring"
        >
          <FolderOpen size={14} />
          Browse...
        </button>
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-[11px] text-fleet-text-subtle">
            {selected ? shortenPath(selected.path) : 'Nothing selected'}
          </span>
          <button
            disabled={!selected}
            onClick={() => selected && onConfirm(selected.path)}
            className="shrink-0 rounded-md fleet-accent-bg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-40 focus-ring"
          >
            Open Agent
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-fleet-border bg-fleet-bg/40 px-5 py-1.5 text-[10px] text-fleet-text-subtle">
        <span>↑↓ navigate</span>
        <span>↵ open agent here</span>
        <span>tab / double-click enter folder</span>
        <span>esc cancel</span>
      </div>
    </Overlay>
  );
}

function GroupLabel({
  children,
  inline = false
}: {
  children: React.ReactNode;
  inline?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={`truncate text-[10px] font-medium uppercase tracking-wider text-fleet-text-subtle ${
        inline ? '' : 'px-5 pb-1 pt-1.5'
      }`}
    >
      {children}
    </div>
  );
}

/**
 * One folder row. Click selects and double-click enters the folder, matching
 * the OS file dialogs this stands in for; confirming is the footer's job.
 */
function Row({
  choice,
  index,
  isSelected,
  onHover,
  onEnterFolder
}: {
  choice: Choice;
  index: number;
  isSelected: boolean;
  onHover: (index: number) => void;
  onEnterFolder: (path: string) => void;
}): React.JSX.Element {
  return (
    <button
      data-index={index}
      onMouseEnter={() => onHover(index)}
      onClick={() => onHover(index)}
      onDoubleClick={() => onEnterFolder(choice.path)}
      className={`flex w-full items-center gap-3 px-5 py-2 text-left transition-colors ${
        isSelected ? 'bg-fleet-surface-2' : 'hover:bg-fleet-surface-2/50'
      }`}
    >
      <span className="shrink-0 text-fleet-text-subtle">
        {choice.kind === 'recent' ? <Clock size={15} /> : <Folder size={15} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fleet-text">{choice.name}</span>
        {/* Only recents need their location spelled out - folder rows sit under
            a heading that already says which directory they came from. */}
        {choice.kind === 'recent' && (
          <span className="block truncate text-xs text-fleet-text-subtle">{choice.parent}</span>
        )}
      </span>
      {isSelected && <ChevronRight size={14} className="shrink-0 text-fleet-text-subtle" />}
    </button>
  );
}
