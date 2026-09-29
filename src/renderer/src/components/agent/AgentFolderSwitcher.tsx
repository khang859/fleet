import { useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Folder, FolderOpen, GitBranch, MessageCircle, Search } from 'lucide-react';
import { headName, truncateBranch, type AgentGitHead } from '../../../../shared/agent-git';
import { collectPaneIds, useWorkspaceStore } from '../../store/workspace-store';
import { useCwdStore } from '../../store/cwd-store';
import { isScratchDir, scratchDir } from '../../lib/scratch';
import { shortenPath } from '../../lib/shorten-path';
import { popperAnim } from '../../lib/motion';
import { folderChoices, type FolderChoice } from './folder-choices';
import { rerootIntoWorktree } from './worktree-target';
import { fuzzyIndices } from '../../lib/commands';

type Worktree = { path: string; branchName: string; repoPath: string };

/** One row of the menu: Scratch first, then the folders. */
type Row = { kind: 'scratch' } | ({ kind: 'folder' } & FolderChoice);

/**
 * The folder of every terminal and agent tab in the workspace, in tab order.
 * A terminal's live folder wins over the one it was opened in: `cd` is how
 * people get to a project, and the tab's own cwd never hears about it.
 */
function useOpenFolders(): string[] {
  const tabs = useWorkspaceStore((s) => s.workspace.tabs);
  const liveCwds = useCwdStore((s) => s.cwds);
  return useMemo(
    () =>
      tabs
        .filter((t) => (t.type ?? 'terminal') === 'terminal' || t.type === 'agent')
        .map((t) => {
          const firstPaneId = collectPaneIds(t.splitRoot)[0];
          return (firstPaneId ? liveCwds.get(firstPaneId) : undefined) ?? t.cwd;
        }),
    [tabs, liveCwds]
  );
}

/**
 * Where a new conversation works, while that can still be changed.
 *
 * Every new agent starts as Scratch, so starting one never asks a question.
 * Pointing it at a project is this menu, on the label that already names the
 * folder, and only until the first message: after that the folder is what the
 * conversation is about.
 */
export function AgentFolderSwitcher({
  cwd,
  label,
  onMove
}: {
  cwd: string;
  label: string;
  onMove: (folderPath: string, worktree?: Worktree) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  const [heads, setHeads] = useState<Map<string, AgentGitHead | null>>(new Map());
  // Cutting a worktree is the one thing here that takes a moment and can fail,
  // so the menu stays open to say both instead of closing on a guess.
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openFolders = useOpenFolders();
  const recentFolders = useWorkspaceStore((s) => s.recentFolders);
  const scratch = isScratchDir(cwd);

  const rows: Row[] = useMemo(() => {
    const folders = folderChoices({ openFolders, recentFolders, current: cwd, filter });
    const scratchRow: Row[] =
      !scratch && (filter === '' || 'scratch'.includes(filter.toLowerCase()))
        ? [{ kind: 'scratch' }]
        : [];
    return [...scratchRow, ...folders.map((f): Row => ({ kind: 'folder', ...f }))];
  }, [openFolders, recentFolders, cwd, filter, scratch]);

  // Branches are read once per open, for the rows on screen. A menu open for a
  // few seconds does not need them kept live.
  const folderKey = rows.map((r) => (r.kind === 'folder' ? r.path : '')).join('|');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const paths = folderKey.split('|').filter((p) => p !== '' && !heads.has(p));
    void Promise.all(
      paths.map(async (p) => [p, await window.fleet.agent.gitHeadAt(p).catch(() => null)] as const)
    ).then((read) => {
      if (cancelled || read.length === 0) return;
      setHeads((prev) => new Map([...prev, ...read]));
    });
    return () => {
      cancelled = true;
    };
    // `heads` is what this fills, not what it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, folderKey]);

  useEffect(() => {
    setSelected((i) => Math.min(i, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  useEffect(() => {
    const row = listRef.current?.querySelector(`[data-index="${selected}"]`);
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const reset = (next: boolean): void => {
    if (creating) return;
    setOpen(next);
    setFilter('');
    setSelected(0);
    setError(null);
    if (next) setHeads(new Map());
  };

  const pick = async (row: Row, worktree: boolean): Promise<void> => {
    if (row.kind === 'scratch') {
      onMove(scratchDir());
      reset(false);
      return;
    }
    if (!worktree) {
      onMove(row.path);
      reset(false);
      return;
    }
    setCreating(true);
    setError(null);
    try {
      // Always from the repository root: `git worktree add` names the branch
      // and the directory after the path it is given.
      const { root } = await window.fleet.git.repoRoot(row.path);
      if (!root) throw new Error('Not a git repository.');
      const created = await window.fleet.worktree.create({ repoPath: root });
      onMove(rerootIntoWorktree(row.path, root, created.worktreePath), {
        path: created.worktreePath,
        branchName: created.branchName,
        repoPath: root
      });
      setCreating(false);
      reset(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  const browse = async (): Promise<void> => {
    setOpen(false);
    const picked = await window.fleet.showFolderPicker();
    if (picked) onMove(picked);
  };

  const isRepo = (row: Row): boolean =>
    row.kind === 'folder' && (heads.get(row.path) ?? null) !== null;

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (creating) {
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Nothing matched: the one way left to get there is the folder picker.
      if (rows.length === 0) {
        void browse();
        return;
      }
      const row = rows.at(selected);
      // ⌥↵ asks for a worktree; a row that cannot have one does nothing
      // rather than quietly doing the plain move instead.
      if (!row || (e.altKey && !isRepo(row))) return;
      void pick(row, e.altKey);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={reset}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={`${cwd} - click to work somewhere else`}
          aria-label={`Folder: ${label}. Change folder`}
          // A border at rest, not only a background on hover: this reads as a
          // label until it looks like something you can press.
          className="flex min-w-0 shrink items-center gap-1 rounded border border-fleet-border px-1.5 py-0.5 text-fleet-text-muted transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text-secondary focus-ring data-[state=open]:bg-fleet-surface-2"
        >
          <FolderIcon scratch={scratch} />
          <span className="truncate">{label}</span>
          <ChevronDown size={11} className="shrink-0" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={6}
          onKeyDown={onKeyDown}
          className={`z-50 flex max-h-[min(60vh,420px)] w-80 flex-col overflow-hidden rounded-lg border border-fleet-border-strong bg-fleet-surface-2 shadow-xl ${popperAnim}`}
        >
          <div className="flex items-center gap-2 border-b border-fleet-border px-3 py-2">
            <Search size={13} className="shrink-0 text-fleet-text-subtle" />
            <input
              autoFocus
              type="text"
              value={filter}
              disabled={creating}
              onChange={(e) => {
                setFilter(e.target.value);
                setSelected(0);
              }}
              spellCheck={false}
              placeholder="Work in..."
              className="min-w-0 flex-1 bg-transparent text-xs text-fleet-text outline-none placeholder:text-fleet-text-subtle"
            />
          </div>

          <div ref={listRef} className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-1">
            {rows.length === 0 && (
              <div className="px-2 py-3 text-xs text-fleet-text-muted">
                No folder matches &ldquo;{filter}&rdquo;. Press ↵ to pick one.
              </div>
            )}
            {rows.map((row, i) => (
              <div key={row.kind === 'scratch' ? 'scratch' : row.path}>
                {startsGroup(rows, i) && row.kind === 'folder' && (
                  <GroupLabel>{row.group === 'open' ? 'Open tabs' : 'Recent'}</GroupLabel>
                )}
                <FolderRow
                  row={row}
                  index={i}
                  head={row.kind === 'folder' ? (heads.get(row.path) ?? null) : null}
                  filter={filter}
                  isSelected={i === selected}
                  disabled={creating}
                  onHover={setSelected}
                  onPick={(worktree) => void pick(row, worktree)}
                />
              </div>
            ))}
          </div>

          {error && (
            <div className="border-t border-fleet-border bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
              Couldn&rsquo;t create the worktree.
              <span className="mt-0.5 block text-red-300/70">{error}</span>
            </div>
          )}

          <button
            type="button"
            disabled={creating}
            onClick={() => void browse()}
            className="flex items-center gap-2 border-t border-fleet-border px-3 py-2 text-left text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-3 disabled:opacity-40"
          >
            <FolderOpen size={13} className="shrink-0" />
            Other folder...
          </button>
          <div className="flex items-center gap-3 border-t border-fleet-border px-3 py-1.5 text-[10px] text-fleet-text-subtle">
            {creating ? (
              <span>Creating worktree...</span>
            ) : (
              <>
                <span>↵ move here</span>
                <span>⌥↵ in new worktree</span>
                <span>esc cancel</span>
              </>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A folder row whose group differs from the row above it gets a heading. */
function startsGroup(rows: Row[], i: number): boolean {
  const row = rows[i];
  if (row.kind !== 'folder') return false;
  if (i === 0) return true;
  const above = rows[i - 1];
  return above.kind !== 'folder' || above.group !== row.group;
}

function GroupLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-fleet-text-subtle">
      {children}
    </div>
  );
}

/**
 * One destination. The name moves the agent there; a repository also gets a
 * worktree button, because a checkout nobody else is editing is the other thing
 * people start an agent for, and a modifier key alone is not discoverable.
 */
function FolderRow({
  row,
  index,
  head,
  filter,
  isSelected,
  disabled,
  onHover,
  onPick
}: {
  row: Row;
  index: number;
  head: AgentGitHead | null;
  filter: string;
  isSelected: boolean;
  disabled: boolean;
  onHover: (index: number) => void;
  onPick: (worktree: boolean) => void;
}): React.JSX.Element {
  const branch = head === null ? null : headName(head);
  return (
    <div
      data-index={index}
      onMouseMove={() => onHover(index)}
      className={`group flex items-center rounded-md ${isSelected ? 'bg-fleet-surface-3' : ''}`}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPick(false)}
        title={row.kind === 'folder' ? row.path : 'A conversation with no project attached'}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left disabled:opacity-40"
      >
        <FolderIcon scratch={row.kind === 'scratch'} size={13} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-fleet-text">
            <Highlighted text={row.kind === 'scratch' ? 'Scratch' : row.name} filter={filter} />
          </span>
          {row.kind === 'folder' && row.group === 'recent' && (
            <span className="block truncate text-[11px] text-fleet-text-subtle">
              {shortenPath(row.path)}
            </span>
          )}
        </span>
        {branch !== null && (
          <span className="flex min-w-0 shrink items-center gap-1 text-[11px] text-fleet-text-muted">
            <GitBranch size={11} className="shrink-0" />
            <bdi className="truncate">{truncateBranch(branch)}</bdi>
          </span>
        )}
      </button>
      {branch !== null && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onPick(true)}
          title={`Open ${row.kind === 'folder' ? row.name : ''} in a new worktree (⌥↵)`}
          className={`mr-1 shrink-0 rounded px-1.5 py-0.5 text-[10px] text-fleet-text-muted transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text disabled:opacity-40 focus-ring ${
            isSelected ? '' : 'opacity-50 group-hover:opacity-100'
          }`}
        >
          + worktree
        </button>
      )}
    </div>
  );
}

/** Scratch or a project, the same way in the switcher, its rows and the locked label. */
export function FolderIcon({
  scratch,
  size = 11
}: {
  scratch: boolean;
  size?: number;
}): React.JSX.Element {
  return scratch ? (
    <MessageCircle size={size} className="shrink-0 text-violet-300" />
  ) : (
    <Folder size={size} className="shrink-0" />
  );
}

/** The name with the letters the filter matched in bold, so it shows why a row is there. */
function Highlighted({ text, filter }: { text: string; filter: string }): React.JSX.Element {
  const hits = new Set(fuzzyIndices(filter, text) ?? []);
  if (hits.size === 0) return <>{text}</>;
  return (
    <>
      {[...text].map((ch, i) =>
        hits.has(i) ? (
          <b key={i} className="font-semibold text-blue-300">
            {ch}
          </b>
        ) : (
          ch
        )
      )}
    </>
  );
}
