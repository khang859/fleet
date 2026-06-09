import { useEffect, useRef, useState } from 'react';
import { useKanbanStore } from '../../store/kanban-store';
import { KanbanColumn } from './KanbanColumn';
import { KanbanDrawer } from './KanbanDrawer';
import { COLUMNS } from './kanban-utils';
import type { TaskStatus } from '../../../../shared/kanban-types';
import {
  Plus,
  Zap,
  Archive,
  Network,
  KanbanSquare,
  Package,
  Layers,
  GitBranch,
  Bot
} from 'lucide-react';
import { SwarmModal } from './SwarmModal';
import { PmChatPanel } from './PmChatPanel';
import { usePmChatStore } from '../../store/pm-chat-store';
import { ArtifactsView } from './ArtifactsView';
import { RuneMissingBanner } from './RuneMissingBanner';
import { FeatureSelector } from './FeatureSelector';
import { FeaturesView } from './FeaturesView';
import { FeaturePrRollup } from './FeaturePrRollup';
import { WorktreeManager } from './WorktreeManager';

export function KanbanBoard(): React.JSX.Element {
  const {
    cards,
    loaded,
    loadBoard,
    openTask,
    openTaskId,
    setStatus,
    createTask,
    nudge,
    boards,
    activeBoardSlug,
    loadBoards,
    switchBoard,
    createBoard,
    renameBoard,
    deleteBoard,
    seed,
    clearSeed,
    createTaskFromArtifact,
    features,
    selectedFeatureId,
    setFocusedFeature
  } = useKanbanStore();
  const focusedFeature = features.find((f) => f.id === selectedFeatureId) ?? null;
  const pmOpen = usePmChatStore((s) => s.panelOpen);
  const togglePm = usePmChatStore((s) => s.togglePanel);
  const [view, setView] = useState<'board' | 'artifacts' | 'features' | 'worktrees'>('board');
  const [search, setSearch] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [swarming, setSwarming] = useState(false);
  const [boardEditor, setBoardEditor] = useState<{ mode: 'new' | 'rename' } | null>(null);
  const [boardName, setBoardName] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newMode, setNewMode] = useState<'scratch' | 'project'>('scratch');
  const [newFolder, setNewFolder] = useState('');
  const [newIsolated, setNewIsolated] = useState(true);
  // null = not applicable / still checking; true/false = the picked folder's git-repo status.
  const [folderIsRepo, setFolderIsRepo] = useState<boolean | null>(null);
  const [newStatus, setNewStatus] = useState<TaskStatus>('triage');
  const draggingId = useRef<string | null>(null);

  useEffect(() => {
    if (!loaded) void loadBoard();
    void loadBoards();
    const off = window.fleet.kanban.onBoardsChanged(() => void loadBoards());
    return off;
  }, [loaded, loadBoard, loadBoards]);

  // A "use artifact as input" request from the drawer opens the matching create surface.
  useEffect(() => {
    if (seed?.target === 'task') setCreating(true);
    if (seed?.target === 'swarm') setSwarming(true);
  }, [seed]);

  // Drop any pending seed when the board unmounts, so navigating away mid-flow doesn't
  // re-open the seeded create form on return.
  useEffect(() => () => clearSeed(), [clearSeed]);

  // Opening the create form while focused on a feature with a repo prefills the
  // workspace from the feature, so the user never re-enters folder config (pain #5).
  useEffect(() => {
    if (creating && focusedFeature?.repoPath) {
      setNewMode('project');
      setNewFolder(focusedFeature.repoPath);
      setNewIsolated(true);
    }
    // Only re-run when the form opens or the focused feature changes.
  }, [creating, focusedFeature?.repoPath]);

  const assignees = Array.from(
    new Set(cards.map((c) => c.assignee).filter((a): a is string => !!a))
  ).sort();

  const visible = cards.filter((c) => {
    if (c.status === 'archived' && !showArchived) return false;
    if (selectedFeatureId && c.featureId !== selectedFeatureId) return false;
    if (assigneeFilter && c.assignee !== assigneeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!c.title.toLowerCase().includes(q) && !c.id.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const columns = showArchived
    ? [...COLUMNS, { status: 'archived' as TaskStatus, label: 'Archived' }]
    : COLUMNS;

  async function pickFolder(): Promise<void> {
    const path = await window.fleet.showFolderPicker();
    if (path) setNewFolder(path);
  }

  // An "isolated copy" (worktree) needs a git repo. Verify the picked folder up
  // front so the form catches it, instead of failing later at claim time.
  useEffect(() => {
    const folder = newFolder.trim();
    if (newMode !== 'project' || !newIsolated || !folder) {
      setFolderIsRepo(null);
      return;
    }
    let cancelled = false;
    setFolderIsRepo(null); // checking…
    window.fleet.git
      .isRepo(folder)
      .then((r) => {
        if (!cancelled) setFolderIsRepo(r.isRepo);
      })
      .catch(() => {
        if (!cancelled) setFolderIsRepo(false);
      });
    return () => {
      cancelled = true;
    };
  }, [newFolder, newMode, newIsolated]);

  async function handleCreate(): Promise<void> {
    const title = newTitle.trim();
    if (!title) return;
    const folder = newFolder.trim();
    if (newMode === 'project' && !folder) return;
    // Block an isolated-copy task on a non-repo folder before it can fail at claim time.
    if (newMode === 'project' && newIsolated) {
      const { isRepo } = await window.fleet.git.isRepo(folder);
      if (!isRepo) {
        setFolderIsRepo(false);
        return;
      }
    }
    const workspace =
      newMode === 'scratch'
        ? { workspaceKind: 'scratch' as const }
        : newIsolated
          ? {
              workspaceKind: 'worktree' as const,
              repoPath: folder,
              baseBranch: focusedFeature?.baseBranch ?? undefined
            }
          : { workspaceKind: 'dir' as const, workspacePath: folder };
    // A task created while a feature is focused joins that feature.
    const featureId = selectedFeatureId ?? undefined;
    try {
      if (seed?.target === 'task') {
        await createTaskFromArtifact(seed.artifact.id, {
          title,
          boardId: activeBoardSlug,
          status: newStatus,
          featureId,
          ...workspace
        });
      } else {
        await createTask({
          title,
          boardId: activeBoardSlug,
          status: newStatus,
          featureId,
          ...workspace
        });
      }
    } catch (err) {
      // Keep the form (and any seed) open so the user can retry or cancel explicitly.
      window.alert(err instanceof Error ? err.message : 'Could not create task');
      return;
    }
    setNewTitle('');
    setNewFolder('');
    setNewMode('scratch');
    setNewIsolated(true);
    setNewStatus('triage');
    setCreating(false);
    clearSeed();
  }

  async function handleBoardSubmit(): Promise<void> {
    const name = boardName.trim();
    if (!name || !boardEditor) return;
    if (boardEditor.mode === 'new') await createBoard(name);
    else await renameBoard(activeBoardSlug, name);
    setBoardName('');
    setBoardEditor(null);
  }

  return (
    <div className="flex h-full w-full flex-col bg-neutral-950 text-neutral-200">
      {/* View toggle: board ↔ artifacts */}
      <div className="flex items-center gap-1 border-b border-neutral-800 px-3 py-1.5">
        <button
          onClick={() => setView('board')}
          className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition active:scale-[0.97] ${
            view === 'board' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-800'
          }`}
        >
          <KanbanSquare size={12} /> Board
        </button>
        <button
          onClick={() => setView('features')}
          className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition active:scale-[0.97] ${
            view === 'features'
              ? 'bg-neutral-700 text-white'
              : 'text-neutral-400 hover:bg-neutral-800'
          }`}
        >
          <Layers size={12} /> Features
        </button>
        <button
          onClick={() => setView('worktrees')}
          className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition active:scale-[0.97] ${
            view === 'worktrees'
              ? 'bg-neutral-700 text-white'
              : 'text-neutral-400 hover:bg-neutral-800'
          }`}
        >
          <GitBranch size={12} /> Branches
        </button>
        <button
          onClick={() => setView('artifacts')}
          className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition active:scale-[0.97] ${
            view === 'artifacts'
              ? 'bg-neutral-700 text-white'
              : 'text-neutral-400 hover:bg-neutral-800'
          }`}
        >
          <Package size={12} /> Artifacts
        </button>
      </div>

      <RuneMissingBanner />

      {view === 'artifacts' ? (
        <ArtifactsView onReuseSeed={() => setView('board')} />
      ) : view === 'features' ? (
        <FeaturesView onFocus={() => setView('board')} />
      ) : view === 'worktrees' ? (
        <WorktreeManager onOpenTask={() => setView('board')} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={activeBoardSlug}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '__new__') {
                    setBoardName('');
                    setBoardEditor({ mode: 'new' });
                  } else {
                    void switchBoard(v);
                  }
                }}
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs outline-none focus:border-blue-500"
                title="Switch board"
              >
                {boards.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.name}
                  </option>
                ))}
                <option value="__new__">＋ New board…</option>
              </select>
              <button
                onClick={() => {
                  const current = boards.find((b) => b.slug === activeBoardSlug);
                  setBoardName(current?.name ?? '');
                  setBoardEditor({ mode: 'rename' });
                }}
                disabled={activeBoardSlug === 'default'}
                className="rounded px-2 py-1 text-xs text-neutral-400 transition active:scale-[0.97] hover:bg-neutral-800 disabled:opacity-40 disabled:active:scale-100"
                title="Rename board"
              >
                Rename
              </button>
              <button
                onClick={() => {
                  if (activeBoardSlug === 'default') return;
                  const current = boards.find((b) => b.slug === activeBoardSlug);
                  if (
                    window.confirm(
                      `Delete board "${current?.name ?? activeBoardSlug}" and all its tasks?`
                    )
                  ) {
                    void deleteBoard(activeBoardSlug).catch((err) =>
                      window.alert(err instanceof Error ? err.message : 'Could not delete board')
                    );
                  }
                }}
                disabled={activeBoardSlug === 'default'}
                className="rounded px-2 py-1 text-xs text-neutral-400 transition active:scale-[0.97] hover:bg-red-900/40 disabled:opacity-40 disabled:active:scale-100"
                title="Delete board"
              >
                Delete
              </button>
              <div className="h-4 w-px bg-neutral-800" />
              <FeatureSelector />
              <div className="h-4 w-px bg-neutral-800" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="w-48 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs outline-none focus:border-blue-500"
              />
              <select
                value={assigneeFilter}
                onChange={(e) => setAssigneeFilter(e.target.value)}
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs outline-none"
              >
                <option value="">All assignees</option>
                {assignees.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setShowArchived((v) => !v)}
                className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition active:scale-[0.97] ${
                  showArchived
                    ? 'bg-neutral-700 text-white'
                    : 'text-neutral-400 hover:bg-neutral-800'
                }`}
              >
                <Archive size={12} /> Archived
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void nudge()}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-400 transition active:scale-[0.97] hover:bg-neutral-800"
                title="Run a dispatcher tick now"
              >
                <Zap size={12} /> Nudge
              </button>
              <button
                onClick={togglePm}
                className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition active:scale-[0.97] ${
                  pmOpen
                    ? 'bg-emerald-700 text-white'
                    : 'bg-emerald-600 text-white hover:bg-emerald-500'
                }`}
                title="Chat with the board PM to shape and create tickets"
              >
                <Bot size={12} /> PM
              </button>
              <button
                onClick={() => setSwarming(true)}
                className="inline-flex items-center gap-1 rounded bg-purple-600 px-2 py-1 text-xs text-white transition active:scale-[0.97] hover:bg-purple-500"
                title="Create a swarm: workers → verifier → synthesizer"
              >
                <Network size={12} /> Swarm
              </button>
              <button
                onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white transition active:scale-[0.97] hover:bg-blue-500"
              >
                <Plus size={12} /> New Task
              </button>
            </div>
          </div>

          {boardEditor && (
            <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-2">
              <input
                autoFocus
                value={boardName}
                onChange={(e) => setBoardName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleBoardSubmit();
                  if (e.key === 'Escape') setBoardEditor(null);
                }}
                placeholder={boardEditor.mode === 'new' ? 'New board name…' : 'Rename board…'}
                className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
              />
              <button
                onClick={() => void handleBoardSubmit()}
                className="rounded bg-blue-600 px-2 py-1 text-xs text-white transition active:scale-[0.97] hover:bg-blue-500"
              >
                {boardEditor.mode === 'new' ? 'Create' : 'Save'}
              </button>
              <button
                onClick={() => setBoardEditor(null)}
                className="rounded px-2 py-1 text-xs text-neutral-400 transition active:scale-[0.97] hover:bg-neutral-800"
              >
                Cancel
              </button>
            </div>
          )}

          {creating && (
            <div className="flex flex-col gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-2">
              {seed?.target === 'task' && (
                <div className="flex items-center gap-1 rounded bg-blue-950/40 px-2 py-1 text-[11px] text-blue-300">
                  📦 Seeding new task with{' '}
                  <span className="font-medium">{seed.artifact.filename}</span>
                </div>
              )}
              {focusedFeature && (
                <div className="flex items-center gap-1 rounded bg-violet-950/40 px-2 py-1 text-[11px] text-violet-300">
                  Creating in feature: <span className="font-medium">{focusedFeature.name}</span>
                </div>
              )}
              <input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreate();
                  if (e.key === 'Escape') {
                    setCreating(false);
                    clearSeed();
                  }
                }}
                placeholder="Task title…"
                className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
              />
              <div className="flex items-center gap-2 text-[11px] font-medium text-neutral-400">
                Column
                <select
                  value={newStatus}
                  onChange={(e) => setNewStatus(e.target.value === 'todo' ? 'todo' : 'triage')}
                  className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs font-normal text-neutral-200 outline-none focus:border-blue-500"
                >
                  <option value="triage">Triage</option>
                  <option value="todo">Todo</option>
                </select>
              </div>
              <div className="text-[11px] font-medium text-neutral-400">
                Where should the agent work?
              </div>
              <label className="flex items-center gap-2 text-xs text-neutral-300">
                <input
                  type="radio"
                  name="ws-mode"
                  checked={newMode === 'scratch'}
                  onChange={() => setNewMode('scratch')}
                />
                Empty sandbox{' '}
                <span className="text-neutral-500">(no project — a fresh, empty folder)</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-neutral-300">
                <input
                  type="radio"
                  name="ws-mode"
                  checked={newMode === 'project'}
                  onChange={() => setNewMode('project')}
                />
                A project folder
              </label>
              {newMode === 'project' && (
                <div className="flex flex-col gap-2 pl-6">
                  <div className="flex items-center gap-2">
                    <input
                      value={newFolder}
                      onChange={(e) => setNewFolder(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleCreate();
                        if (e.key === 'Escape') {
                          setCreating(false);
                          clearSeed();
                        }
                      }}
                      placeholder="No folder selected…"
                      className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={() => void pickFolder()}
                      className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 transition active:scale-[0.97] hover:bg-neutral-800"
                    >
                      Browse…
                    </button>
                  </div>
                  <label className="flex items-start gap-2 text-xs text-neutral-300">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={newIsolated}
                      onChange={(e) => setNewIsolated(e.target.checked)}
                    />
                    <span>
                      Work on an isolated copy{' '}
                      <span className="text-neutral-500">
                        (git worktree — recommended; leaves your files untouched. Requires a git
                        repo.)
                      </span>
                    </span>
                  </label>
                  {newIsolated && newFolder.trim() !== '' && folderIsRepo === false && (
                    <p className="text-[10px] text-red-400">
                      Not a git repository — an isolated copy needs a git repo. Uncheck to work in
                      the folder directly, or pick a repo.
                    </p>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void handleCreate()}
                  disabled={
                    newMode === 'project' &&
                    newIsolated &&
                    newFolder.trim() !== '' &&
                    folderIsRepo !== true
                  }
                  className="rounded bg-blue-600 px-2 py-1 text-xs text-white transition active:scale-[0.97] hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
                >
                  Create
                </button>
                <button
                  onClick={() => {
                    setCreating(false);
                    clearSeed();
                  }}
                  className="rounded px-2 py-1 text-xs text-neutral-400 transition active:scale-[0.97] hover:bg-neutral-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <FeaturePrRollup />

          {focusedFeature && visible.length === 0 && (
            <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400">
              No visible tasks in <span className="font-medium">{focusedFeature.name}</span>.
              <button
                onClick={() => setFocusedFeature(null)}
                className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 transition active:scale-[0.97] hover:bg-neutral-800"
              >
                Clear filter
              </button>
            </div>
          )}

          <div className="flex flex-1 gap-3 overflow-x-auto p-3">
            {columns.map((col) => (
              <KanbanColumn
                key={col.status}
                status={col.status}
                label={col.label}
                cards={visible.filter((c) => c.status === col.status)}
                onOpen={(id) => void openTask(id)}
                onDragStart={(id) => {
                  draggingId.current = id;
                }}
                onDragEnd={() => {
                  draggingId.current = null;
                }}
                onDropCard={(status) => {
                  const id = draggingId.current;
                  draggingId.current = null;
                  if (!id) return;
                  const card = cards.find((c) => c.id === id);
                  if (!card || card.status === status) return;
                  // Review is worktree-only (the command layer rejects it too).
                  if (status === 'review' && card.workspaceKind !== 'worktree') return;
                  void setStatus(id, status);
                }}
              />
            ))}
          </div>

          {openTaskId && <KanbanDrawer />}
          {pmOpen && <PmChatPanel boardId={activeBoardSlug} shiftLeft={openTaskId !== null} />}

          <SwarmModal
            open={swarming}
            onClose={() => {
              setSwarming(false);
              clearSeed();
            }}
          />
        </>
      )}
    </div>
  );
}
