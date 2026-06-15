import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { learningToMarkdown, type Learning } from '../../../../shared/learnings';

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export function LearningsBrowser({
  onOpenSource,
  refreshKey = 0
}: {
  onOpenSource?: (l: Learning) => void;
  /** Bump to force a refetch (e.g. after a new learning is distilled elsewhere). */
  refreshKey?: number;
}): React.JSX.Element {
  const [items, setItems] = useState<Learning[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Learning | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', body: '', tags: '' });
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async (q: string): Promise<Learning[]> => {
    const res = await window.fleet.learnings.search(q.trim() ? { query: q.trim() } : {});
    setItems(res);
    return res;
  }, []);

  // Debounce the per-keystroke search and ignore out-of-order responses, so a slow
  // earlier query can't overwrite the results of a newer one. Also re-runs when
  // refreshKey changes (a learning was saved elsewhere).
  useEffect(() => {
    let ignore = false;
    const q = query.trim();
    const timer = setTimeout(() => {
      void window.fleet.learnings.search(q ? { query: q } : {}).then((res) => {
        if (!ignore) setItems(res);
      });
    }, 300);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [query, refreshKey]);

  function open(l: Learning): void {
    setSelected(l);
    setEditing(false);
    setCopied(false);
  }

  async function copy(): Promise<void> {
    if (!selected) return;
    await navigator.clipboard.writeText(learningToMarkdown(selected));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function startEdit(): void {
    if (!selected) return;
    setDraft({ title: selected.title, body: selected.body, tags: selected.tags.join(', ') });
    setEditing(true);
  }

  async function saveEdit(): Promise<void> {
    if (!selected) return;
    const tags = draft.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const fields = { title: draft.title.trim(), body: draft.body.trim(), tags };
    const updated = await window.fleet.learnings.update(selected.id, fields);
    setEditing(false);
    // Fall back to the edited draft if the IPC returns falsy, so the detail panel
    // never keeps showing the pre-edit content.
    setSelected(updated ?? { ...selected, ...fields, updatedAt: Date.now() });
    await refresh(query);
  }

  async function remove(): Promise<void> {
    if (!selected) return;
    if (!window.confirm(`Delete learning "${selected.title}"?`)) return;
    await window.fleet.learnings.delete(selected.id);
    setSelected(null);
    await refresh(query);
  }

  return (
    <div
      className="grid h-full"
      style={{ gridTemplateColumns: '320px 1fr', gridTemplateRows: 'minmax(0, 1fr)' }}
    >
      {/* List */}
      <div className="flex h-full flex-col border-r border-fleet-border">
        <div className="border-b border-fleet-border px-3 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search learnings…"
            className="w-full rounded border border-fleet-border-strong bg-fleet-surface px-2 py-1 text-sm text-fleet-text"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-fleet-text-subtle">
              {query.trim()
                ? 'No matching learnings.'
                : 'No learnings yet. Distill one from a session.'}
            </div>
          ) : (
            items.map((l) => {
              const isSel = selected?.id === l.id;
              return (
                <div
                  key={l.id}
                  onClick={() => open(l)}
                  className={`cursor-pointer border-b border-fleet-border/40 px-3 py-2 ${isSel ? 'bg-blue-600/15' : 'hover:bg-fleet-surface-2/50'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-fleet-text">{l.title}</span>
                    <span className="flex-shrink-0 text-[10px] text-fleet-text-subtle">
                      {relativeTime(l.createdAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-fleet-text-subtle">
                    {l.sourceProject && <span className="truncate">{l.sourceProject}</span>}
                    {l.tags.slice(0, 3).map((t) => (
                      <span key={t} className="rounded bg-fleet-surface-2 px-1">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Detail */}
      {!selected ? (
        <div className="flex h-full items-center justify-center text-sm text-fleet-text-subtle">
          Select a learning to view it.
        </div>
      ) : (
        <div className="flex h-full min-w-0 flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-fleet-border px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-fleet-text">{selected.title}</div>
              <div className="text-xs text-fleet-text-subtle">
                {selected.sourceProject ?? 'no project'}
                {selected.model ? ` · ${selected.model}` : ''} · {relativeTime(selected.createdAt)}
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              {!editing && (
                <>
                  <button
                    onClick={() => void copy()}
                    className="rounded border border-fleet-border-strong px-2 py-1.5 text-xs text-fleet-text-subtle hover:bg-fleet-surface-2/50"
                  >
                    {copied ? 'Copied ✓' : 'Copy'}
                  </button>
                  <button
                    onClick={() => void window.fleet.learnings.export(selected.id)}
                    className="rounded border border-fleet-border-strong px-2 py-1.5 text-xs text-fleet-text-subtle hover:bg-fleet-surface-2/50"
                  >
                    Export…
                  </button>
                  {selected.sourceSessionId && onOpenSource && (
                    <button
                      onClick={() => onOpenSource(selected)}
                      className="rounded border border-fleet-border-strong px-2 py-1.5 text-xs text-fleet-text-subtle hover:bg-fleet-surface-2/50"
                    >
                      Source ▸
                    </button>
                  )}
                  <button
                    onClick={startEdit}
                    className="rounded border border-fleet-border-strong px-2 py-1.5 text-xs text-fleet-text-subtle hover:bg-fleet-surface-2/50"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => void remove()}
                    className="rounded px-2 py-1.5 text-xs text-red-400 hover:bg-red-900/30"
                  >
                    Delete
                  </button>
                </>
              )}
              {editing && (
                <>
                  <button
                    onClick={() => setEditing(false)}
                    className="rounded px-2 py-1.5 text-xs text-fleet-text-subtle hover:bg-fleet-surface-2/50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void saveEdit()}
                    disabled={draft.title.trim() === ''}
                    className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    Save
                  </button>
                </>
              )}
            </div>
          </div>

          {editing ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
              <input
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder="Title"
                className="w-full rounded border border-fleet-border-strong bg-fleet-surface px-2 py-1 text-sm text-fleet-text"
              />
              <textarea
                value={draft.body}
                onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                className="min-h-[300px] flex-1 resize-none rounded border border-fleet-border-strong bg-fleet-surface px-2 py-1 font-mono text-xs leading-relaxed text-fleet-text"
              />
              <input
                value={draft.tags}
                onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
                placeholder="Tags (comma-separated)"
                className="w-full rounded border border-fleet-border-strong bg-fleet-surface px-2 py-1 text-xs text-fleet-text"
              />
            </div>
          ) : (
            <div className="markdown-preview min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm text-fleet-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {selected.body}
              </ReactMarkdown>
              {selected.tags.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-1 border-t border-fleet-border pt-3">
                  {selected.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded bg-fleet-surface-2 px-1.5 py-0.5 text-[10px] text-fleet-text-subtle"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
