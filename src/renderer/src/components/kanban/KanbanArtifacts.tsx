import { useState } from 'react';
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
  MoreHorizontal,
  Download,
  FolderOpen,
  AlertTriangle
} from 'lucide-react';
import { useKanbanStore } from '../../store/kanban-store';
import { useSettingsStore } from '../../store/settings-store';
import { formatBytes } from './kanban-utils';
import type {
  TaskArtifact,
  ArtifactKind,
  TaskDetail,
  TaskEvent
} from '../../../../shared/kanban-types';
import type { KanbanArtifactPreviewResponse } from '../../../../shared/ipc-api';

const KIND_ICON: Record<ArtifactKind, typeof FileText> = {
  document: FileText,
  code: FileCode,
  data: Database,
  other: File
};

/** Scan the task's events for an active (not-yet-discarded) scratch-leftover warning. */
function activeLeftovers(events: TaskEvent[]): string[] {
  let warnAt = -1;
  let clearAt = -1;
  let files: string[] = [];
  for (const e of events) {
    if (e.kind === 'artifacts_unregistered' && e.id > warnAt) {
      warnAt = e.id;
      const raw = e.payload?.files;
      files = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
    }
    if (e.kind === 'artifacts_unregistered_discarded' && e.id > clearAt) clearAt = e.id;
  }
  return warnAt > clearAt ? files : [];
}

function ArtifactRow({
  art,
  retentionDays
}: {
  art: TaskArtifact;
  retentionDays: number;
}): React.JSX.Element {
  const {
    discardArtifact,
    restoreArtifact,
    removeArtifact,
    saveArtifactCopy,
    revealArtifact,
    readArtifactPreview,
    requestSeed,
    closeTask
  } = useKanbanStore();
  const [preview, setPreview] = useState<KanbanArtifactPreviewResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
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

  function seedAsInput(target: 'task' | 'swarm'): void {
    requestSeed({ id: art.id, filename: art.filename }, target);
    closeTask();
  }

  return (
    <div className={`mb-1 rounded bg-neutral-950 px-2 py-1 ${discarded ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon size={12} className="shrink-0 text-neutral-500" />
          <span
            className={`truncate ${discarded ? 'line-through' : ''}`}
            title={art.title ? `${art.title} · ${art.filename}` : art.filename}
          >
            {label}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[10px] text-neutral-500">
          {formatBytes(art.size)}
          {discarded ? (
            <button
              onClick={() => void restoreArtifact(art.id)}
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
                onClick={() => void discardArtifact(art.id)}
                title="Discard"
                aria-label="Discard artifact"
                className="text-neutral-400 hover:text-amber-400"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
          <button
            onClick={() => setMenu((v) => !v)}
            title="More actions"
            aria-label="More artifact actions"
            className={`hover:text-neutral-200 ${menu ? 'text-neutral-200' : 'text-neutral-400'}`}
          >
            <MoreHorizontal size={12} />
          </button>
        </span>
      </div>

      {menu && (
        <div className="mt-1 flex flex-wrap items-center gap-1 border-t border-neutral-800 pt-1 text-[10px]">
          <button
            onClick={() => {
              setMenu(false);
              void saveArtifactCopy(art.id);
            }}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
          >
            <Download size={11} /> Download
          </button>
          <button
            onClick={() => {
              setMenu(false);
              void revealArtifact(art.id);
            }}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
          >
            <FolderOpen size={11} /> Reveal
          </button>
          {!discarded && (
            <>
              <span className="ml-1 text-neutral-600">Use as input:</span>
              <button
                onClick={() => seedAsInput('task')}
                className="rounded px-1.5 py-0.5 text-blue-300 hover:bg-neutral-800"
              >
                New task
              </button>
              <button
                onClick={() => seedAsInput('swarm')}
                className="rounded px-1.5 py-0.5 text-purple-300 hover:bg-neutral-800"
              >
                New swarm
              </button>
            </>
          )}
          <button
            onClick={() => {
              if (window.confirm(`Permanently delete "${label}"? This cannot be undone.`)) {
                setMenu(false);
                void removeArtifact(art.id);
              }
            }}
            className="ml-auto rounded px-1.5 py-0.5 text-red-400 hover:bg-red-900/40"
          >
            Delete permanently
          </button>
        </div>
      )}

      {discarded && (
        <p className="mt-0.5 text-[10px] text-neutral-600">
          {retentionDays > 0
            ? `Auto-removed ${retentionDays} day${retentionDays === 1 ? '' : 's'} after discard.`
            : 'Hidden until removed manually.'}
        </p>
      )}

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

export function OutputsSection({ detail }: { detail: TaskDetail }): React.JSX.Element | null {
  const { revealTaskWorkspace, discardTaskWorkspaceLeftovers } = useKanbanStore();
  const retentionDays = useSettingsStore((s) => s.settings?.kanban.artifactRetentionDays ?? 0);
  const [showOther, setShowOther] = useState(false);

  const leftovers = activeLeftovers(detail.events);
  const kept = detail.artifacts.filter((a) => a.state === 'kept');
  const discarded = detail.artifacts.filter((a) => a.state === 'discarded');

  // Omit the section entirely when there is nothing to show (no empty box).
  if (kept.length === 0 && discarded.length === 0 && leftovers.length === 0) return null;

  const docs = kept.filter((a) => a.kind === 'document');
  const others = kept.filter((a) => a.kind !== 'document');

  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1 font-semibold text-neutral-400">
        <Package size={12} /> Outputs ({kept.length})
      </h3>
      <p className="mb-1 text-[10px] text-neutral-600">
        Discarded outputs are recoverable until auto-removal.
      </p>

      {leftovers.length > 0 && (
        <div className="mb-2 rounded border border-amber-700/50 bg-amber-950/30 p-2">
          <p className="flex items-center gap-1 text-[11px] text-amber-300">
            <AlertTriangle size={12} /> {leftovers.length} unregistered file
            {leftovers.length === 1 ? '' : 's'} remain in this task&apos;s workspace.
          </p>
          <p className="mt-0.5 truncate text-[10px] text-amber-500/80" title={leftovers.join(', ')}>
            {leftovers.join(', ')}
          </p>
          <div className="mt-1 flex gap-1.5">
            <button
              onClick={() => void revealTaskWorkspace(detail.task.id)}
              className="rounded border border-amber-700/60 px-2 py-0.5 text-[10px] text-amber-200 hover:bg-amber-900/40"
            >
              Reveal folder
            </button>
            <button
              onClick={() => {
                if (window.confirm('Delete the unregistered files in this task workspace?')) {
                  void discardTaskWorkspaceLeftovers(detail.task.id);
                }
              }}
              className="rounded border border-amber-700/60 px-2 py-0.5 text-[10px] text-amber-200 hover:bg-amber-900/40"
            >
              Discard them
            </button>
          </div>
        </div>
      )}

      {docs.map((a) => (
        <ArtifactRow key={a.id} art={a} retentionDays={retentionDays} />
      ))}

      {others.length > 0 && (
        <>
          <button
            onClick={() => setShowOther((v) => !v)}
            className="my-1 text-[10px] text-neutral-500 hover:text-neutral-300"
          >
            {showOther ? '▾' : '▸'} {others.length} other file{others.length === 1 ? '' : 's'}
          </button>
          {showOther &&
            others.map((a) => <ArtifactRow key={a.id} art={a} retentionDays={retentionDays} />)}
        </>
      )}

      {discarded.length > 0 && (
        <div className="mt-2">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-neutral-600">Discarded</p>
          {discarded.map((a) => (
            <ArtifactRow key={a.id} art={a} retentionDays={retentionDays} />
          ))}
        </div>
      )}
    </section>
  );
}
