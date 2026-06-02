import { useEffect, useState } from 'react';
import { GitBranch, Trash2, RefreshCw, Check, ArrowUp, ArrowDown, Loader2 } from 'lucide-react';
import { useKanbanStore } from '../../store/kanban-store';

/**
 * Worktree lifecycle manager (a top-level Kanban view, Phase 4). Lists the live
 * worktrees on the board with ahead/behind + merged status, links each to its task,
 * and offers per-worktree prune plus a "Prune merged" bulk sweep. Pruning a running
 * task's worktree is blocked; unmerged branches are preserved (never force-deleted).
 */
export function WorktreeManager({ onOpenTask }: { onOpenTask: () => void }): React.JSX.Element {
  const worktrees = useKanbanStore((s) => s.worktrees);
  const loadWorktrees = useKanbanStore((s) => s.loadWorktrees);
  const pruneWorktree = useKanbanStore((s) => s.pruneWorktree);
  const pruneMergedWorktrees = useKanbanStore((s) => s.pruneMergedWorktrees);
  const openTask = useKanbanStore((s) => s.openTask);

  const [busy, setBusy] = useState<string | null>(null); // taskId or 'bulk'
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void loadWorktrees();
  }, [loadWorktrees]);

  // Mirror the backend bulk-prune predicate: merged worktrees of finished tasks.
  const isFinished = (s: string): boolean => s === 'done' || s === 'archived';
  const mergedCount = worktrees.filter((w) => w.merged && isFinished(w.status)).length;

  async function prune(taskId: string): Promise<void> {
    setBusy(taskId);
    setMsg(null);
    try {
      const res = await pruneWorktree(taskId);
      if (!res.ok) setMsg(res.error ?? 'Prune failed');
      else if (res.branchKept) setMsg('Worktree removed; unmerged branch kept.');
    } finally {
      setBusy(null);
    }
  }

  async function pruneAll(): Promise<void> {
    setBusy('bulk');
    setMsg(null);
    try {
      const res = await pruneMergedWorktrees();
      setMsg(
        `Pruned ${res.pruned} merged worktree${res.pruned === 1 ? '' : 's'}` +
          (res.keptUnmerged > 0 ? `; kept ${res.keptUnmerged} unmerged.` : '.')
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-neutral-900 text-neutral-200">
      <header className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-300">
          <GitBranch size={15} className="text-emerald-400" /> Branches
        </h2>
        <span className="text-[11px] text-neutral-600">{worktrees.length}</span>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <button
            onClick={() => void loadWorktrees()}
            className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800"
          >
            <RefreshCw size={12} /> Refresh
          </button>
          <button
            onClick={() => void pruneAll()}
            disabled={busy !== null || mergedCount === 0}
            className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2 py-1 text-white hover:bg-emerald-600 disabled:opacity-40"
            title="Remove every merged worktree on this board"
          >
            {busy === 'bulk' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            Prune merged ({mergedCount})
          </button>
        </div>
      </header>

      {msg && (
        <div className="border-b border-neutral-800 bg-neutral-950 px-4 py-1.5 text-[11px] text-neutral-400">
          {msg}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {worktrees.length === 0 ? (
          <p className="mt-8 text-center text-xs text-neutral-600">
            No live worktrees on this board. Merged worktrees are pruned automatically.
          </p>
        ) : (
          <div className="space-y-2">
            {worktrees.map((w) => (
              <section
                key={w.taskId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2"
              >
                <button
                  onClick={() => {
                    void openTask(w.taskId);
                    onOpenTask();
                  }}
                  className="truncate text-left text-sm font-medium text-neutral-200 hover:underline"
                  title={w.title}
                >
                  {w.title}
                </button>
                {w.merged ? (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 text-[10px] uppercase tracking-wide text-emerald-300">
                    <Check size={10} /> merged
                  </span>
                ) : (
                  <span className="rounded bg-amber-500/20 px-1.5 text-[10px] uppercase tracking-wide text-amber-300">
                    unmerged
                  </span>
                )}
                {w.status === 'running' && (
                  <span className="rounded bg-blue-500/20 px-1.5 text-[10px] uppercase tracking-wide text-blue-300">
                    running
                  </span>
                )}

                <span className="inline-flex items-center gap-2 font-mono text-[10px] text-neutral-500">
                  <span className="inline-flex items-center gap-0.5 text-emerald-400">
                    <ArrowUp size={10} />
                    {w.ahead}
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-red-400">
                    <ArrowDown size={10} />
                    {w.behind}
                  </span>
                </span>
                {w.branchName && (
                  <span className="truncate font-mono text-[10px] text-neutral-600">
                    {w.branchName} → {w.baseBranch ?? '?'}
                  </span>
                )}

                <button
                  onClick={() => void prune(w.taskId)}
                  disabled={busy !== null || w.status === 'running' || w.status === 'review'}
                  className="ml-auto inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
                  title={
                    w.status === 'running' || w.status === 'review'
                      ? `finish the ${w.status} task first`
                      : 'Remove this worktree'
                  }
                >
                  {busy === w.taskId ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Trash2 size={11} />
                  )}
                  Prune
                </button>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
