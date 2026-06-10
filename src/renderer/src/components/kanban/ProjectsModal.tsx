import { useCallback, useEffect, useState } from 'react';
import { FolderGit2, Plus, Star, Trash2, X } from 'lucide-react';
import type { Project } from '../../../../shared/kanban-types';
import { useWorkspaceStore } from '../../store/workspace-store';
import { Overlay } from '../Overlay';

interface ProjectsModalProps {
  open: boolean;
  boardSlug: string;
  onClose: () => void;
}

/** Manage the board's registered project folders (PM code context + ticket routing). */
export function ProjectsModal({ open, boardSlug, onClose }: ProjectsModalProps): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const addRecentFolder = useWorkspaceStore((s) => s.addRecentFolder);

  const refresh = useCallback(async () => {
    setProjects(await window.fleet.kanban.listProjects(boardSlug));
  }, [boardSlug]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function handleAdd(): Promise<void> {
    setError(null);
    const path = await window.fleet.showFolderPicker();
    if (!path) return;
    const name = path.split('/').filter(Boolean).pop() ?? path;
    try {
      await window.fleet.kanban.addProject({ boardId: boardSlug, name, path });
      addRecentFolder(path);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add project');
    }
  }

  async function handleRemove(id: string): Promise<void> {
    setError(null);
    try {
      await window.fleet.kanban.removeProject(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove project');
    }
  }

  async function handleSetDefault(id: string): Promise<void> {
    setError(null);
    try {
      await window.fleet.kanban.setDefaultProject(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set default project');
    }
  }

  return (
    <Overlay
      open={open}
      onClose={onClose}
      panelClassName="w-[480px] max-w-[90vw] rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-neutral-200"
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FolderGit2 size={14} /> Board Projects
        </div>
        <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-neutral-800">
          <X size={14} />
        </button>
      </div>
      <p className="mb-3 text-xs text-neutral-500">
        Folders the board PM can read for code context. New tickets route to the default project
        unless another is named.
      </p>
      <div className="mb-3 flex flex-col gap-1">
        {projects.length === 0 && (
          <div className="rounded border border-dashed border-neutral-800 px-3 py-4 text-center text-xs text-neutral-500">
            No projects registered yet.
          </div>
        )}
        {projects.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="font-medium">{p.name}</span>
                {p.isDefault && (
                  <span className="rounded bg-emerald-900/60 px-1 text-[10px] text-emerald-300">
                    default
                  </span>
                )}
              </div>
              <div className="truncate text-[10px] text-neutral-500" title={p.path}>
                {p.path}
              </div>
            </div>
            {!p.isDefault && (
              <button
                onClick={() => void handleSetDefault(p.id)}
                title="Make default"
                className="rounded p-1 text-neutral-400 transition hover:bg-neutral-800"
              >
                <Star size={12} />
              </button>
            )}
            <button
              onClick={() => void handleRemove(p.id)}
              title="Remove project"
              className="rounded p-1 text-neutral-400 transition hover:bg-neutral-800 hover:text-red-400"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
      <button
        onClick={() => void handleAdd()}
        className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white transition active:scale-[0.97] hover:bg-blue-500"
      >
        <Plus size={12} /> Add Folder…
      </button>
    </Overlay>
  );
}
