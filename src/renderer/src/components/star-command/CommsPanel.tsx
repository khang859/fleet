import { useState, useCallback, useEffect } from 'react';
import { useStarCommandStore } from '../../store/star-command-store';
import type { CommInfo } from '../../store/star-command-store';

function SectionHeader({ title, count }: { title: string; count?: number }): React.JSX.Element {
  return (
    <h3 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">
      {title}
      {count !== undefined && <span className="ml-1 text-neutral-600">({count})</span>}
    </h3>
  );
}

function typeColor(type: string): string {
  switch (type) {
    case 'awaiting_feedback':
      return 'text-yellow-400';
    case 'hailing':
      return 'text-teal-400';
    case 'status':
      return 'text-blue-400';
    case 'blocker':
      return 'text-red-400';
    case 'directive':
      return 'text-purple-400';
    default:
      return 'text-neutral-400';
  }
}

function CommCard({
  comm,
  onRefresh
}: {
  comm: CommInfo;
  onRefresh: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [resolveText, setResolveText] = useState('');
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMarkRead = async (): Promise<void> => {
    await window.fleet.starbase.markCommsRead(comm.id);
    onRefresh();
  };

  const handleDelete = async (): Promise<void> => {
    await window.fleet.starbase.deleteComms(comm.id);
    onRefresh();
  };

  const handleResolve = async (): Promise<void> => {
    if (!resolveText.trim()) return;
    setResolving(true);
    setError(null);
    try {
      await window.fleet.starbase.resolveComms(comm.id, resolveText.trim());
      setResolveText('');
      setExpanded(false);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve');
    }
    setResolving(false);
  };

  let payloadPreview = comm.payload;
  try {
    const parsed: unknown = JSON.parse(comm.payload);
    if (typeof parsed === 'string') {
      payloadPreview = parsed;
    } else if (typeof parsed === 'object' && parsed !== null && 'message' in parsed) {
      const msg = (parsed as Record<string, unknown>)['message'];
      if (typeof msg === 'string') payloadPreview = msg;
    }
  } catch {
    // raw string payload
  }
  if (payloadPreview.length > 80) payloadPreview = payloadPreview.slice(0, 80) + '…';

  return (
    <div
      className={`bg-neutral-800 rounded-lg border overflow-hidden ${comm.read ? 'border-neutral-700' : 'border-teal-700'}`}
    >
      <button
        className="w-full text-left px-3 py-2 flex items-start justify-between hover:bg-neutral-750 transition-colors gap-2"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {!comm.read && (
              <span className="w-1.5 h-1.5 rounded-full bg-teal-400 flex-shrink-0 mt-0.5" />
            )}
            <span className={`text-[10px] font-mono font-bold uppercase ${typeColor(comm.type)}`}>
              {comm.type}
            </span>
            <span className="text-xs text-neutral-400">
              from <span className="text-neutral-200 font-mono">{comm.from_crew ?? '—'}</span>
            </span>
            <span className="text-[10px] text-neutral-600 ml-auto">
              {new Date(comm.created_at).toLocaleTimeString()}
            </span>
          </div>
          <p className="text-xs text-neutral-400 mt-0.5 truncate">{payloadPreview}</p>
        </div>
        <span className="text-xs text-neutral-600 flex-shrink-0 mt-0.5">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-neutral-700 pt-2 space-y-2">
          {/* Full payload */}
          <div className="bg-neutral-900 rounded p-2 text-xs font-mono text-neutral-300 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {comm.payload}
          </div>

          {/* Resolve input */}
          <div className="flex gap-2">
            <input
              type="text"
              value={resolveText}
              onChange={(e) => setResolveText(e.target.value)}
              placeholder="Response message..."
              className="flex-1 bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1 border border-neutral-600 focus:border-blue-500 focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleResolve();
              }}
            />
            <button
              onClick={() => {
                void handleResolve();
              }}
              disabled={!resolveText.trim() || resolving}
              className="px-2 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-xs rounded transition-colors"
            >
              {resolving ? '...' : 'Resolve'}
            </button>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex items-center gap-2">
            {!comm.read && (
              <button
                onClick={() => {
                  void handleMarkRead();
                }}
                className="text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                Mark Read
              </button>
            )}
            <button
              onClick={() => {
                void handleDelete();
              }}
              className="text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CommsPanel(): React.JSX.Element {
  const { commsList, setCommsList, setUnreadCount } = useStarCommandStore();
  const [clearConfirm, setClearConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await window.fleet.starbase.listComms({ limit: 100 });
      setCommsList(all);
      const unread = await window.fleet.starbase.getUnreadComms();
      setUnreadCount(unread.length);
    } catch {
      // ignore
    }
  }, [setCommsList, setUnreadCount]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleReadAll = async (): Promise<void> => {
    await window.fleet.starbase.markAllCommsRead();
    void refresh();
  };

  const handleClearAll = async (): Promise<void> => {
    setError(null);
    try {
      await window.fleet.starbase.clearComms();
      setClearConfirm(false);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear');
    }
  };

  const unread = commsList.filter((c) => !c.read);
  const read = commsList.filter((c) => c.read);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-neutral-300 font-semibold">Comms Inbox</div>
        <div className="flex items-center gap-2">
          {unread.length > 0 && (
            <button
              onClick={() => {
                void handleReadAll();
              }}
              className="text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              Read All
            </button>
          )}
          {clearConfirm ? (
            <div className="flex items-center gap-1.5 bg-red-950/60 border border-red-800/50 rounded px-2 py-1">
              <span className="text-[10px] text-red-300">Clear all?</span>
              <button
                onClick={() => {
                  void handleClearAll();
                }}
                className="text-[10px] px-1.5 py-0.5 bg-red-700 hover:bg-red-600 text-white rounded transition-colors"
              >
                Confirm
              </button>
              <button
                onClick={() => setClearConfirm(false)}
                className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setClearConfirm(true)}
              className="text-xs text-neutral-500 hover:text-red-400 transition-colors"
            >
              Clear All
            </button>
          )}
        </div>
      </div>

      {error && <div className="text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">{error}</div>}

      {/* Unread */}
      {unread.length > 0 && (
        <section>
          <SectionHeader title="Unread" count={unread.length} />
          <div className="space-y-2">
            {unread.map((c) => (
              <CommCard
                key={c.id}
                comm={c}
                onRefresh={() => {
                  void refresh();
                }}
              />
            ))}
          </div>
        </section>
      )}

      {/* Read */}
      {read.length > 0 && (
        <section>
          <SectionHeader title="Read" count={read.length} />
          <div className="space-y-2">
            {read.map((c) => (
              <CommCard
                key={c.id}
                comm={c}
                onRefresh={() => {
                  void refresh();
                }}
              />
            ))}
          </div>
        </section>
      )}

      {commsList.length === 0 && (
        <p className="text-xs text-neutral-600 text-center py-8">No transmissions</p>
      )}
    </div>
  );
}
