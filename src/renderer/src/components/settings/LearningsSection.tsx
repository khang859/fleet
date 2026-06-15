import { useCallback, useEffect, useState } from 'react';
import type { LearningsStatus } from '../../../../shared/learnings';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function statusLabel(status: LearningsStatus | null): string {
  if (!status) return 'Checking…';
  if (!status.vectorSupport) return 'Keyword only (vector extension unavailable)';
  switch (status.embedder) {
    case 'ready':
      return 'Semantic search active';
    case 'loading':
    case 'idle':
      return 'Preparing model…';
    case 'failed':
      return 'Keyword only (model unavailable)';
  }
}

export function LearningsSection(): React.JSX.Element {
  const [status, setStatus] = useState<LearningsStatus | null>(null);
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const [s, size] = await Promise.all([
      window.fleet.learnings.status(),
      window.fleet.learnings.modelCacheSize()
    ]);
    setStatus(s);
    setCacheBytes(size);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clearCache = useCallback(async (): Promise<void> => {
    if (!window.confirm('Delete the downloaded embedding model? It re-downloads on next use.'))
      return;
    setClearing(true);
    try {
      await window.fleet.learnings.clearModelCache();
      await load();
    } finally {
      setClearing(false);
    }
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-white mb-1">Learnings</h2>
        <p className="text-sm text-neutral-400">
          Semantic search over your cross-project Learnings knowledge base. Embeddings run locally —
          nothing leaves your machine.
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-neutral-300">Semantic search</h3>
        <div className="flex items-center justify-between">
          <label className="text-sm text-neutral-400">Status</label>
          <span className="text-sm text-white">{statusLabel(status)}</span>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm text-neutral-400 block">Model cache</label>
            <span className="text-xs text-neutral-500">
              all-MiniLM-L6-v2, downloaded on first use
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-white">
              {cacheBytes === null ? '…' : formatBytes(cacheBytes)}
            </span>
            <button
              onClick={() => void clearCache()}
              disabled={clearing || !cacheBytes}
              className="px-2.5 py-1 text-sm rounded-md bg-neutral-800 border border-neutral-700 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.97] transition"
            >
              {clearing ? 'Clearing…' : 'Clear cache'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
