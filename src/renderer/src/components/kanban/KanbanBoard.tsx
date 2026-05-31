import { useEffect, useRef, useState } from 'react';
import { useKanbanStore } from '../../store/kanban-store';
import { KanbanColumn } from './KanbanColumn';
import { KanbanDrawer } from './KanbanDrawer';
import { COLUMNS } from './kanban-utils';
import type { TaskStatus, WorkspaceKind } from '../../../../shared/kanban-types';
import { Plus, Zap, Archive } from 'lucide-react';

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
    deleteBoard
  } = useKanbanStore();
  const [search, setSearch] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newKind, setNewKind] = useState<WorkspaceKind>('scratch');
  const [newRepo, setNewRepo] = useState('');
  const draggingId = useRef<string | null>(null);

  useEffect(() => {
    if (!loaded) void loadBoard();
    void loadBoards();
    const off = window.fleet.kanban.onBoardsChanged(() => void loadBoards());
    return off;
  }, [loaded, loadBoard, loadBoards]);

  const assignees = Array.from(
    new Set(cards.map((c) => c.assignee).filter((a): a is string => !!a))
  ).sort();

  const visible = cards.filter((c) => {
    if (c.status === 'archived' && !showArchived) return false;
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

  async function handleCreate(): Promise<void> {
    const title = newTitle.trim();
    if (!title) return;
    if (newKind === 'worktree' && !newRepo.trim()) return;
    await createTask({
      title,
      workspaceKind: newKind,
      ...(newKind === 'worktree' ? { repoPath: newRepo.trim() } : {})
    });
    setNewTitle('');
    setNewRepo('');
    setNewKind('scratch');
    setCreating(false);
  }

  return (
    <div className="flex h-full w-full flex-col bg-neutral-950 text-neutral-200">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <select
          value={activeBoardSlug}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__new__') {
              const name = window.prompt('New board name');
              if (name?.trim()) void createBoard(name.trim());
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
            const name = window.prompt('Rename board', current?.name ?? '');
            if (name?.trim()) void renameBoard(activeBoardSlug, name.trim());
          }}
          disabled={activeBoardSlug === 'default'}
          className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-40"
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
          className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-red-900/40 disabled:opacity-40"
          title="Delete board"
        >
          Delete
        </button>
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
          className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${
            showArchived ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-800'
          }`}
        >
          <Archive size={12} /> Archived
        </button>
        <div className="flex-1" />
        <button
          onClick={() => void nudge()}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
          title="Run a dispatcher tick now"
        >
          <Zap size={12} /> Nudge
        </button>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
        >
          <Plus size={12} /> New Task
        </button>
      </div>

      {creating && (
        <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-2">
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
              if (e.key === 'Escape') setCreating(false);
            }}
            placeholder="Task title…"
            className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
          />
          <select
            value={newKind}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'scratch' || v === 'dir' || v === 'worktree') setNewKind(v);
            }}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs outline-none"
          >
            <option value="scratch">scratch</option>
            <option value="dir">dir</option>
            <option value="worktree">worktree</option>
          </select>
          {newKind === 'worktree' && (
            <input
              value={newRepo}
              onChange={(e) => setNewRepo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
                if (e.key === 'Escape') setCreating(false);
              }}
              placeholder="Source repo path…"
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
            />
          )}
          <button
            onClick={() => void handleCreate()}
            className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
          >
            Create
          </button>
          <button
            onClick={() => setCreating(false)}
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
          >
            Cancel
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
              if (card && card.status !== status) void setStatus(id, status);
            }}
          />
        ))}
      </div>

      {openTaskId && <KanbanDrawer />}
    </div>
  );
}
