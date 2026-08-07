import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Clock,
  Folder,
  FolderOpen,
  GitBranch,
  Search
} from 'lucide-react';
import { Overlay } from '../Overlay';
import { useWorkspaceStore } from '../../store/workspace-store';
import { fuzzyMatch } from '../../lib/commands';
import { basename } from '../../lib/path-utils';
import { shortenPath } from '../../lib/shorten-path';
import { crumbTrail, parentDir, type Crumb } from './folder-crumbs';
import { rerootIntoWorktree } from './worktree-target';

/** How many recent folders ride above the listing. */
const RECENT_LIMIT = 5;

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
 * What we know about the folder being browsed. A folder the OS refuses to read
 * has to say so - reporting it as empty makes browsing look broken rather than
 * blocked, and macOS has plenty of these under `~/Library`.
 */
type Listing =
  | { status: 'loading' }
  | { status: 'ready'; entries: Choice[] }
  | { status: 'error'; message: string };

/**
 * Keeps the search field focused when something in the dialog is clicked.
 * Without it the click moves focus onto that button and every key binding -
 * going up a folder included - stops responding, with nothing on screen to say
 * why or how to recover.
 */
function keepFocus(e: React.MouseEvent): void {
  e.preventDefault();
}

type AgentFolderDialogProps = {
  open: boolean;
  onCancel: () => void;
  onConfirm: (
    folderPath: string,
    worktree?: { path: string; branchName: string; repoPath: string }
  ) => void;
};

/**
 * Asks which folder a new agent should work in. Recent folders are the fast
 * path; the listing underneath starts at the user's home directory so a folder
 * that was never opened before is still a couple of keystrokes away, and
 * "Browse" hands off to the OS picker for anywhere else on disk.
 *
 * The folder being browsed is itself a valid answer, so there is always a
 * target: with no row selected it is the folder the breadcrumb names, and
 * selecting a row narrows it to that child.
 *
 * A target inside a git repository can also be opened in a worktree of its own,
 * giving the agent a branch and a working tree nobody else is editing.
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
  // `null` is the cursor sitting above the first row, where the target is the
  // folder being browsed rather than anything inside it.
  const [selectedIndex, setSelectedIndex] = useState<number | null>(0);
  const [listing, setListing] = useState<Listing>({ status: 'loading' });
  const [worktreeMode, setWorktreeMode] = useState(false);
  // Whether the current target sits in a git repo, and so can be worktree'd.
  const [targetIsRepo, setTargetIsRepo] = useState(false);
  // Creating a worktree is the one thing here that can take a visible moment
  // and can fail, so it gets to say both rather than closing on a guess.
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);

  // Every open starts fresh at home rather than resuming wherever the last
  // session wandered to - the home folder is the one location that means the
  // same thing on macOS, Windows and Linux.
  useEffect(() => {
    if (!open) return;
    setDir(homeDir);
    setFilter('');
    setSelectedIndex(0);
    setWorktreeMode(false);
    setError(null);
    setCreating(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, homeDir]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setListing({ status: 'loading' });
    void window.fleet.file.readdir(dir).then((result) => {
      if (cancelled) return;
      setListing(
        result.success
          ? {
              status: 'ready',
              entries: result.entries
                .filter((e) => e.isDirectory)
                .map((e) => ({ path: e.path, name: e.name, kind: 'folder' as const }))
            }
          : { status: 'error', message: result.error }
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
        .slice(0, RECENT_LIMIT)
        .map((folder) => ({
          path: folder,
          name: basename(folder) || folder,
          parent: shortenPath(parentDir(folder) ?? folder),
          kind: 'recent' as const
        })),
    [recentFolders, filter]
  );

  const folders: Choice[] = useMemo(() => {
    if (listing.status !== 'ready') return [];
    const lower = filter.toLowerCase();
    return (
      listing.entries
        .filter((e) => e.name.toLowerCase().includes(lower))
        // Dotfolders are noise until the user types the dot themselves.
        .filter((e) => filter.startsWith('.') || !e.name.startsWith('.'))
    );
  }, [listing, filter]);

  const choices = useMemo(() => [...recents, ...folders], [recents, folders]);
  const selected = selectedIndex === null ? undefined : choices.at(selectedIndex);
  // There is always somewhere to open the agent: the selected row, or failing
  // that the folder being browsed.
  const target = selected?.path ?? dir;
  const crumbs = useMemo(() => crumbTrail(dir, homeDir), [dir, homeDir]);
  const parent = parentDir(dir);

  // Whether a worktree is even possible follows the target around, since the
  // cursor can move between a repository and a plain folder without the
  // browsed directory changing at all.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    void window.fleet.git
      .isRepo(target)
      .then((result) => {
        if (!cancelled) setTargetIsRepo(result.isRepo);
      })
      .catch(() => {
        if (!cancelled) setTargetIsRepo(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, target]);

  // A listing can shrink under the cursor - entering a folder with fewer
  // entries than the last one had. Pull the cursor back to the final row
  // instead of leaving it pointed past the end at nothing.
  useEffect(() => {
    setSelectedIndex((i) => (i === null ? null : Math.min(i, Math.max(choices.length - 1, 0))));
  }, [choices.length]);

  useEffect(() => {
    if (selectedIndex === null) return;
    const child = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    if (child instanceof HTMLElement) child.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, choices]);

  // Deep trails overflow the panel; keep the end - where the user is - in view.
  useLayoutEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [crumbs]);

  // A folder is read from its top. Inheriting the last one's scroll offset
  // drops the user into the middle of a listing they have not seen yet, with
  // the headings that say what they are looking at scrolled off above.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [dir]);

  /** Browse into a folder instead of opening an agent in it. */
  const enterFolder = useCallback((path: string) => {
    setDir(path);
    setFilter('');
    // Land on the folder itself rather than on its first row: that row would
    // be a recent from somewhere else entirely, and Enter would open it.
    setSelectedIndex(null);
    inputRef.current?.focus();
  }, []);

  /**
   * Open the agent at `path`, first cutting it a worktree if asked. The
   * worktree is always taken from the repository root - `git worktree add`
   * names both the branch and the directory after the path it is handed, and a
   * subfolder would name them after itself.
   */
  const confirm = useCallback(
    async (path: string, worktree: boolean): Promise<void> => {
      if (!worktree) {
        onConfirm(path);
        return;
      }
      setCreating(true);
      setError(null);
      try {
        const { root } = await window.fleet.git.repoRoot(path);
        if (!root) throw new Error('Not a git repository.');
        const created = await window.fleet.worktree.create({ repoPath: root });
        onConfirm(rerootIntoWorktree(path, root, created.worktreePath), {
          path: created.worktreePath,
          branchName: created.branchName,
          repoPath: root
        });
      } catch (err) {
        // Staying open with the reason on screen beats closing on a failure the
        // user would only discover by noticing the agent is on the wrong branch.
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCreating(false);
      }
    },
    [onConfirm]
  );

  const browse = useCallback(async () => {
    const picked = await window.fleet.showFolderPicker();
    if (picked) await confirm(picked, worktreeMode);
  }, [confirm, worktreeMode]);

  /** True when the caret sits at `edge` of the search field with nothing selected. */
  const caretAt = (edge: 'start' | 'end'): boolean => {
    const el = inputRef.current;
    if (!el) return true;
    const at = edge === 'start' ? 0 : el.value.length;
    return el.selectionStart === el.selectionEnd && el.selectionStart === at;
  };

  // Bound to the panel rather than the search field, so a click that lands on a
  // row cannot quietly take the keyboard away with it.
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // A worktree is being cut; every key here would act on a dialog that is
    // about to be replaced by the pane it opened.
    if (creating) {
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => (i === null ? 0 : Math.min(i + 1, choices.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      // Past the top row is the folder being browsed, which the breadcrumb
      // marks as the target once the cursor lands back there.
      setSelectedIndex((i) => (i === null || i === 0 ? null : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Alt is the shortcut for the checkbox below, so the keyboard-only path
      // to a worktree does not run through toggling state first.
      void confirm(target, (worktreeMode || e.altKey) && targetIsRepo);
    } else if (e.key === 'Tab' || e.key === 'ArrowRight') {
      // Arrow keys belong to the text field whenever the caret can still move.
      if (e.key === 'ArrowRight' && !caretAt('end')) return;
      e.preventDefault();
      enterFolder(selected?.path ?? dir);
    } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
      if (!parent) return;
      if (e.key === 'ArrowLeft' ? !caretAt('start') : filter !== '') return;
      e.preventDefault();
      enterFolder(parent);
    }
  };

  return (
    <Overlay
      open={open}
      onClose={onCancel}
      // Dismissing while the worktree is being cut would not stop it: the
      // branch and directory still land, and the pane still opens - moments
      // later, over whatever the user turned to instead. The work is short, so
      // the dialog holds until it is done rather than growing a way to abort.
      closeOnEscape={!creating}
      closeOnBackdrop={!creating}
      containerClassName="justify-center"
      panelClassName="mt-[12vh] w-[600px] h-[min(64vh,520px)] bg-fleet-surface border border-fleet-border-strong rounded-xl overflow-hidden"
    >
      <div className="flex h-full flex-col" onKeyDown={handleKeyDown}>
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

        <div className="flex items-center gap-2 border-t border-fleet-border bg-fleet-bg/40 px-5 py-2.5">
          <Search size={14} className="shrink-0 text-fleet-text-subtle" />
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setSelectedIndex(0);
            }}
            spellCheck={false}
            placeholder="Search recent and nearby folders..."
            className="flex-1 bg-transparent text-sm text-fleet-text outline-none placeholder:text-fleet-text-subtle"
          />
        </div>

        <Breadcrumbs
          ref={crumbsRef}
          crumbs={crumbs}
          parent={parent}
          isTarget={selectedIndex === null}
          onNavigate={enterFolder}
        />

        <div ref={listRef} className="no-scrollbar min-h-0 flex-1 overflow-y-auto py-1.5">
          {recents.length > 0 && (
            <>
              <GroupLabel>Recent</GroupLabel>
              {recents.map((choice, i) => (
                <Row
                  key={`recent-${choice.path}`}
                  choice={choice}
                  index={i}
                  isSelected={i === selectedIndex}
                  onSelect={setSelectedIndex}
                  onEnterFolder={enterFolder}
                />
              ))}
              <GroupLabel>Folders</GroupLabel>
            </>
          )}

          {listing.status === 'error' ? (
            <div className="px-5 py-5 text-sm text-fleet-text-muted">
              Can&rsquo;t open this folder.
              <span className="mt-0.5 block text-xs text-fleet-text-subtle">{listing.message}</span>
            </div>
          ) : listing.status === 'ready' && folders.length === 0 ? (
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
                onSelect={setSelectedIndex}
                onEnterFolder={enterFolder}
              />
            ))
          )}
        </div>

        {error && (
          <div className="border-t border-fleet-border bg-red-500/10 px-5 py-2 text-xs text-red-300">
            Couldn&rsquo;t create the worktree.
            <span className="mt-0.5 block text-[11px] text-red-300/70">{error}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-fleet-border px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => void browse()}
              disabled={creating}
              className="flex shrink-0 items-center gap-2 rounded-md border border-fleet-border-strong px-3 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 focus-ring"
            >
              <FolderOpen size={14} />
              Browse...
            </button>
            <label
              onMouseDown={keepFocus}
              title={
                targetIsRepo
                  ? 'Give the agent its own branch and working tree'
                  : 'Not a git repository'
              }
              className={`flex shrink-0 items-center gap-2 text-xs ${
                targetIsRepo && !creating
                  ? 'cursor-pointer text-fleet-text-secondary'
                  : 'cursor-default text-fleet-text-subtle opacity-40'
              }`}
            >
              <input
                type="checkbox"
                checked={worktreeMode && targetIsRepo}
                disabled={!targetIsRepo || creating}
                onChange={(e) => setWorktreeMode(e.target.checked)}
                className="size-3.5 shrink-0 fleet-accent-input focus-ring"
              />
              <GitBranch size={13} className="shrink-0" />
              New worktree
            </label>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <span className="truncate text-[11px] text-fleet-text-subtle">
              {shortenPath(target)}
            </span>
            <button
              onClick={() => void confirm(target, worktreeMode && targetIsRepo)}
              disabled={creating}
              className="shrink-0 rounded-md fleet-accent-bg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-60 focus-ring-offset"
            >
              {creating ? 'Creating worktree...' : 'Open Agent'}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-fleet-border bg-fleet-bg/40 px-5 py-1.5 text-[10px] text-fleet-text-subtle">
          <span>↑↓ select</span>
          <span>↵ open agent</span>
          {targetIsRepo && <span>⌥↵ in worktree</span>}
          <span>→ enter folder</span>
          <span>← go up</span>
          <span>esc cancel</span>
        </div>
      </div>
    </Overlay>
  );
}

/**
 * The trail from `~` (or the filesystem root) down to the folder on screen.
 * Pinned above the listing rather than scrolling with it, because a way back up
 * that disappears the moment you scroll is no way back up at all.
 */
function Breadcrumbs({
  ref,
  crumbs,
  parent,
  isTarget,
  onNavigate
}: {
  ref: React.Ref<HTMLDivElement>;
  crumbs: Crumb[];
  parent: string | null;
  /** The folder on screen is where the agent would open, so name it as such. */
  isTarget: boolean;
  onNavigate: (path: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 border-y border-fleet-border px-3 py-1.5">
      <button
        disabled={!parent}
        onMouseDown={keepFocus}
        onClick={() => parent && onNavigate(parent)}
        title="Go up a folder (←)"
        className="shrink-0 rounded p-1 text-fleet-text-subtle transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text disabled:pointer-events-none disabled:opacity-30 focus-ring"
      >
        <ChevronLeft size={14} />
      </button>
      <div ref={ref} className="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <Fragment key={crumb.path}>
              {i > 0 && <ChevronRight size={11} className="shrink-0 text-fleet-text-subtle/60" />}
              <button
                onMouseDown={keepFocus}
                onClick={() => onNavigate(crumb.path)}
                disabled={isLast}
                className={`shrink-0 rounded px-1.5 py-0.5 text-xs transition-colors focus-ring ${
                  isLast
                    ? isTarget
                      ? 'font-medium fleet-accent-text'
                      : 'font-medium text-fleet-text'
                    : 'text-fleet-text-muted hover:bg-fleet-surface-2 hover:text-fleet-text'
                }`}
              >
                {crumb.label}
              </button>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="truncate px-5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-fleet-text-subtle">
      {children}
    </div>
  );
}

/**
 * One folder row, carrying two different destinations: the name picks the
 * folder, the chevron browses into it. They get separate hit areas because a
 * single row that does both depending on how you click it is the thing users
 * cannot read - double-click alone left browsing undiscoverable.
 */
function Row({
  choice,
  index,
  isSelected,
  onSelect,
  onEnterFolder
}: {
  choice: Choice;
  index: number;
  isSelected: boolean;
  onSelect: (index: number) => void;
  onEnterFolder: (path: string) => void;
}): React.JSX.Element {
  return (
    <div
      data-index={index}
      className={`group relative flex items-center transition-colors ${
        isSelected ? 'bg-fleet-surface-2' : 'hover:bg-fleet-surface-2/50'
      }`}
    >
      {isSelected && <span className="absolute inset-y-0 left-0 w-0.5 fleet-accent-bg" />}
      <button
        onMouseDown={keepFocus}
        onClick={() => onSelect(index)}
        onDoubleClick={() => onEnterFolder(choice.path)}
        className="flex min-w-0 flex-1 items-center gap-3 px-5 py-2 text-left focus-ring"
      >
        <span className="shrink-0 text-fleet-text-subtle">
          {choice.kind === 'recent' ? <Clock size={15} /> : <Folder size={15} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fleet-text">{choice.name}</span>
          {/* Only recents need their location spelled out - folder rows sit under
              the breadcrumb that already says which directory they came from. */}
          {choice.kind === 'recent' && (
            <span className="block truncate text-xs text-fleet-text-subtle">{choice.parent}</span>
          )}
        </span>
      </button>
      <button
        onMouseDown={keepFocus}
        onClick={() => onEnterFolder(choice.path)}
        title={`Browse ${choice.name}`}
        className={`mr-3 shrink-0 rounded p-1 text-fleet-text-subtle transition-colors hover:bg-fleet-surface-3 hover:text-fleet-text focus-ring ${
          isSelected ? '' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}
