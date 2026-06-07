import { useEffect, useRef, useState } from 'react';
import { Overlay } from '../Overlay';
import { useKanbanStore } from '../../store/kanban-store';
import type { Feature } from '../../../../shared/kanban-types';

/**
 * Create or edit a feature. In edit mode a Delete action is offered (hard delete:
 * member tasks are detached, then the feature row is removed).
 */
export function FeaturePickerModal({
  open,
  feature,
  onClose
}: {
  open: boolean;
  feature: Feature | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const activeBoardSlug = useKanbanStore((s) => s.activeBoardSlug);
  const createFeature = useKanbanStore((s) => s.createFeature);
  const updateFeature = useKanbanStore((s) => s.updateFeature);
  const deleteFeature = useKanbanStore((s) => s.deleteFeature);
  const setFocusedFeature = useKanbanStore((s) => s.setFocusedFeature);

  // Snapshot the feature being edited so its values stay stable through the exit
  // animation (the parent clears `feature` to null the moment it closes us).
  const [shown, setShown] = useState<Feature | null>(feature);
  const [name, setName] = useState(feature?.name ?? '');
  const [repoPath, setRepoPath] = useState(feature?.repoPath ?? '');
  const [baseBranch, setBaseBranch] = useState(feature?.baseBranch ?? '');
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form from the incoming feature each time the modal opens.
  const prevOpen = useRef(false);
  useEffect(() => {
    if (open && !prevOpen.current) {
      setShown(feature);
      setName(feature?.name ?? '');
      setRepoPath(feature?.repoPath ?? '');
      setBaseBranch(feature?.baseBranch ?? '');
      setError(null);
    }
    prevOpen.current = open;
  }, [open, feature]);

  const editing = shown !== null;

  async function pickFolder(): Promise<void> {
    const path = await window.fleet.showFolderPicker();
    if (path) setRepoPath(path);
  }

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('A feature name is required.');
      return;
    }
    const repo = repoPath.trim() === '' ? null : repoPath.trim();
    const base = baseBranch.trim() === '' ? null : baseBranch.trim();
    try {
      if (shown) {
        await updateFeature(shown.id, { name: trimmed, repoPath: repo, baseBranch: base });
      } else {
        const created = await createFeature({
          boardId: activeBoardSlug,
          name: trimmed,
          repoPath: repo,
          baseBranch: base
        });
        setFocusedFeature(created.id);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(): Promise<void> {
    if (!shown) return;
    if (
      !window.confirm(
        `Delete feature "${shown.name}"? Its tasks are kept but un-grouped from the feature.`
      )
    ) {
      return;
    }
    try {
      await deleteFeature(shown.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Overlay open={open} onClose={onClose}>
      <div className="w-[460px] rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-100">
          {editing ? 'Edit feature' : 'New feature'}
        </h2>
        <label className="mb-3 block text-xs text-neutral-300">
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder="Feature name…"
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
          />
        </label>
        <label className="mb-3 block text-xs text-neutral-300">
          Project folder{' '}
          <span className="text-neutral-500">(inherited by member tasks — optional)</span>
          <div className="mt-1 flex items-center gap-2">
            <input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="No folder selected…"
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
            />
            <button
              onClick={() => void pickFolder()}
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 transition hover:bg-neutral-800 active:scale-[0.97]"
            >
              Browse…
            </button>
          </div>
        </label>
        <label className="mb-3 block text-xs text-neutral-300">
          Base branch <span className="text-neutral-500">(merge target — optional)</span>
          <input
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            placeholder="e.g. main"
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs outline-none focus:border-blue-500"
          />
        </label>
        {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
        <div className="flex items-center justify-between">
          {editing ? (
            <button
              onClick={() => void handleDelete()}
              className="rounded px-3 py-1 text-xs text-red-400 transition hover:bg-red-900/40 active:scale-[0.97]"
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded px-3 py-1 text-xs text-neutral-400 transition hover:bg-neutral-800 active:scale-[0.97]"
            >
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              className="rounded bg-blue-600 px-3 py-1 text-xs text-white transition hover:bg-blue-500 active:scale-[0.97]"
            >
              {editing ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
