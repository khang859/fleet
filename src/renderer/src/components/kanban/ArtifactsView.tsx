import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  Package,
  FileText,
  FileCode,
  Database,
  File,
  Eye,
  Trash2,
  RotateCcw,
  Download,
  FolderOpen,
  Sprout
} from 'lucide-react';
import { useKanbanStore } from '../../store/kanban-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { formatBytes } from './kanban-utils';
import type {
  ArtifactListItem,
  ArtifactKind,
  ArtifactState
} from '../../../../shared/kanban-types';
import type { KanbanArtifactPreviewResponse } from '../../../../shared/ipc-api';

const KIND_ICON: Record<ArtifactKind, typeof FileText> = {
  document: FileText,
  code: FileCode,
  data: Database,
  other: File
};

const KIND_OPTIONS: ArtifactKind[] = ['document', 'code', 'data', 'other'];
const STATE_OPTIONS: ArtifactState[] = ['kept', 'discarded'];

/** A task → run grouping of the flat artifact list (preserves the list's created-desc order). */
type TaskGroup = {
  taskId: string;
  taskTitle: string;
  boardName: string;
  runs: Array<{ runId: number | null; items: ArtifactListItem[] }>;
};

function groupByTaskRun(items: ArtifactListItem[]): TaskGroup[] {
  const tasks: TaskGroup[] = [];
  const taskIndex = new Map<string, TaskGroup>();
  for (const art of items) {
    let group = taskIndex.get(art.taskId);
    if (!group) {
      group = {
        taskId: art.taskId,
        taskTitle: art.taskTitle || art.taskId,
        boardName: art.boardName,
        runs: []
      };
      taskIndex.set(art.taskId, group);
      tasks.push(group);
    }
    let run = group.runs.find((r) => r.runId === art.runId);
    if (!run) {
      run = { runId: art.runId, items: [] };
      group.runs.push(run);
    }
    run.items.push(art);
  }
  return tasks;
}

function ArtifactRow({
  art,
  onChanged,
  onReuse
}: {
  art: ArtifactListItem;
  onChanged: () => void;
  onReuse: (art: ArtifactListItem, target: 'task' | 'swarm') => void;
}): React.JSX.Element {
  const {
    discardArtifact,
    restoreArtifact,
    removeArtifact,
    saveArtifactCopy,
    revealArtifact,
    readArtifactPreview
  } = useKanbanStore();
  const [preview, setPreview] = useState<KanbanArtifactPreviewResponse | null>(null);
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[art.kind];
  const label = art.title ?? art.filename;
  const discarded = art.state === 'discarded';

  async function togglePreview(): Promise<void> {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!preview) setPreview(await readArtifactPreview(art.id));
  }

  async function act(fn: (id: string) => Promise<void>): Promise<void> {
    await fn(art.id);
    onChanged();
  }

  return (
    <div className={`rounded bg-neutral-950 px-2 py-1 ${discarded ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon size={12} className="shrink-0 text-neutral-500" />
          <span
            className={`truncate text-xs ${discarded ? 'line-through' : ''}`}
            title={art.title ? `${art.title} · ${art.filename}` : art.filename}
          >
            {label}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[10px] text-neutral-500">
          {formatBytes(art.size)}
          {discarded ? (
            <button
              onClick={() => void act(restoreArtifact)}
              title="Restore"
              aria-label="Restore artifact"
              className="text-neutral-400 hover:text-emerald-400"
            >
              <RotateCcw size={12} />
            </button>
          ) : (
            <>
              <button
                onClick={() => void togglePreview()}
                title="Preview"
                aria-label="Preview artifact"
                className={`hover:text-blue-400 ${open ? 'text-blue-400' : 'text-neutral-400'}`}
              >
                <Eye size={12} />
              </button>
              <button
                onClick={() => onReuse(art, 'task')}
                title="Use as input for a new task"
                aria-label="Use as input"
                className="text-neutral-400 hover:text-blue-300"
              >
                <Sprout size={12} />
              </button>
              <button
                onClick={() => void act(discardArtifact)}
                title="Discard"
                aria-label="Discard artifact"
                className="text-neutral-400 hover:text-amber-400"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
          <button
            onClick={() => void saveArtifactCopy(art.id)}
            title="Download a copy"
            aria-label="Download artifact"
            className="text-neutral-400 hover:text-neutral-200"
          >
            <Download size={12} />
          </button>
          <button
            onClick={() => void revealArtifact(art.id)}
            title="Reveal in file manager"
            aria-label="Reveal artifact"
            className="text-neutral-400 hover:text-neutral-200"
          >
            <FolderOpen size={12} />
          </button>
          {discarded && (
            <button
              onClick={() => {
                if (window.confirm(`Permanently delete "${label}"? This cannot be undone.`)) {
                  void act(removeArtifact);
                }
              }}
              title="Delete permanently"
              aria-label="Delete artifact permanently"
              className="text-red-400 hover:text-red-300"
            >
              ✕
            </button>
          )}
        </span>
      </div>

      {open && (
        <div className="mt-1 border-t border-neutral-800 pt-1">
          {!preview && <p className="text-[10px] text-neutral-500">Loading preview…</p>}
          {preview && !preview.previewable && (
            <p className="text-[10px] text-amber-400" title={preview.reason}>
              ⚠ Preview unavailable
            </p>
          )}
          {preview && preview.previewable && (
            <>
              {art.kind === 'document' ? (
                <div className="markdown-preview max-h-64 overflow-y-auto rounded border border-neutral-800 bg-neutral-900 p-2">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {preview.text}
                  </ReactMarkdown>
                </div>
              ) : (
                <pre className="max-h-64 overflow-auto rounded border border-neutral-800 bg-neutral-900 p-2 text-[10px] text-neutral-300">
                  {preview.text}
                </pre>
              )}
              {preview.truncated && (
                <p className="mt-0.5 text-[10px] text-neutral-600">Preview truncated.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ArtifactsView(): React.JSX.Element {
  const boards = useKanbanStore((s) => s.boards);
  const loadBoards = useKanbanStore((s) => s.loadBoards);
  const requestSeed = useKanbanStore((s) => s.requestSeed);

  const [board, setBoard] = useState('');
  const [kind, setKind] = useState<ArtifactKind | ''>('');
  const [state, setState] = useState<ArtifactState | ''>('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ArtifactListItem[]>([]);

  const reload = useCallback(async () => {
    const list = await window.fleet.kanban.listArtifacts({
      boardSlug: board || undefined,
      kind: kind || undefined,
      state: state || undefined,
      query: query.trim() || undefined
    });
    setItems(list);
  }, [board, kind, state, query]);

  useEffect(() => {
    void loadBoards();
  }, [loadBoards]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Refresh when artifacts change elsewhere (worker registration, retention purge).
  useEffect(() => {
    const cleanup = window.fleet.kanban.onEvent(() => {
      void reload();
    });
    return cleanup;
  }, [reload]);

  const onReuse = useCallback(
    (art: ArtifactListItem, target: 'task' | 'swarm') => {
      // Seeds into the active Kanban board (per design); jump to the Kanban tab to finish.
      requestSeed({ id: art.id, filename: art.filename }, target);
      const ws = useWorkspaceStore.getState();
      const kanbanTab = ws.workspace.tabs.find((t) => t.type === 'kanban');
      if (kanbanTab) ws.setActiveTab(kanbanTab.id);
    },
    [requestSeed]
  );

  const groups = groupByTaskRun(items);

  return (
    <div className="flex h-full flex-col bg-neutral-900 text-neutral-200">
      <header className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-300">
          <Package size={15} className="text-amber-400" /> Artifacts
        </h2>
        <span className="text-[11px] text-neutral-600">{items.length}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <select
            value={board}
            onChange={(e) => setBoard(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
          >
            <option value="">All boards</option>
            {boards.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.name}
              </option>
            ))}
          </select>
          <select
            value={kind}
            onChange={(e) => setKind(KIND_OPTIONS.find((k) => k === e.target.value) ?? '')}
            className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
          >
            <option value="">All kinds</option>
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select
            value={state}
            onChange={(e) => setState(STATE_OPTIONS.find((s) => s === e.target.value) ?? '')}
            className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
          >
            <option value="">Kept &amp; discarded</option>
            <option value="kept">Kept</option>
            <option value="discarded">Discarded</option>
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-40 rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
          />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {groups.length === 0 ? (
          <p className="mt-8 text-center text-xs text-neutral-600">
            No artifacts match these filters. Agents register outputs with the{' '}
            <code className="text-neutral-500">kanban_artifact</code> tool.
          </p>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <section key={g.taskId}>
                <div className="mb-1 flex items-baseline gap-2">
                  <h3
                    className="truncate text-xs font-semibold text-neutral-300"
                    title={g.taskTitle}
                  >
                    {g.taskTitle}
                  </h3>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-neutral-600">
                    {g.boardName}
                  </span>
                </div>
                <div className="space-y-2 border-l border-neutral-800 pl-3">
                  {g.runs.map((run) => (
                    <div key={run.runId ?? 'none'}>
                      <p className="mb-0.5 text-[10px] uppercase tracking-wide text-neutral-600">
                        {run.runId === null ? 'No run' : `Run #${run.runId}`}
                      </p>
                      <div className="space-y-1">
                        {run.items.map((art) => (
                          <ArtifactRow
                            key={art.id}
                            art={art}
                            onChanged={() => void reload()}
                            onReuse={onReuse}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
