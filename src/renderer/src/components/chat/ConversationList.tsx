import { useMemo } from 'react';
import { Plus, Trash2, GitBranch, Download, Pin, Search, X } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import type { ChatConversation } from '../../../../shared/chat-types';

const DAY = 86_400_000;

/** Compact relative age for a conversation row (now / 5m / 2h / 3d). */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

const BUCKET_ORDER = [
  'Today',
  'Yesterday',
  'Previous 7 days',
  'Previous 30 days',
  'Older'
] as const;

/** Bucket a conversation by how recently it was updated, for recency grouping. */
function bucketOf(updatedAt: number, startOfToday: number): (typeof BUCKET_ORDER)[number] {
  if (updatedAt >= startOfToday) return 'Today';
  if (updatedAt >= startOfToday - DAY) return 'Yesterday';
  if (updatedAt >= startOfToday - 7 * DAY) return 'Previous 7 days';
  if (updatedAt >= startOfToday - 30 * DAY) return 'Previous 30 days';
  return 'Older';
}

/** Uppercase group label in the established sidebar section-header style. */
function SectionHeader({ label }: { label: string }): React.JSX.Element {
  return (
    <p className="truncate bg-fleet-surface/40 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-fleet-text-subtle">
      {label}
    </p>
  );
}

/** A single conversation row: title, recency, and hover-revealed actions. */
function Row({ c }: { c: ChatConversation }): React.JSX.Element {
  const activeId = useChatStore((s) => s.activeId);
  const select = useChatStore((s) => s.selectConversation);
  const remove = useChatStore((s) => s.deleteConversation);
  const exportConversation = useChatStore((s) => s.exportConversation);
  const setPinned = useChatStore((s) => s.setConversationPinned);
  const isSel = c.id === activeId;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void select(c.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void select(c.id);
        }
      }}
      className={`group animate-in fade-in cursor-pointer border-b border-fleet-border/40 px-3 py-2 outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fleet-border-strong ${
        isSel ? 'bg-blue-600/15' : 'hover:bg-fleet-surface-2/50'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {c.pinned && (
            <Pin size={11} className="shrink-0 rotate-45 fill-current text-fleet-accent" />
          )}
          {c.parentConversationId && (
            <GitBranch size={12} className="shrink-0 text-fleet-text-muted" />
          )}
          <span
            className={`truncate text-sm ${isSel ? 'text-fleet-text' : 'text-fleet-text-secondary'}`}
          >
            {c.title}
          </span>
        </span>
        {/* Recency shows at rest; the action cluster replaces it on hover/focus. */}
        <span className="shrink-0">
          <span className="text-[10px] tabular-nums text-fleet-text-subtle group-hover:hidden group-focus-within:hidden">
            {relativeTime(c.updatedAt)}
          </span>
          <span className="hidden items-center gap-1.5 group-hover:flex group-focus-within:flex">
            <button
              aria-label={c.pinned ? 'Unpin conversation' : 'Pin conversation'}
              title={c.pinned ? 'Unpin' : 'Pin'}
              onClick={(e) => {
                e.stopPropagation();
                void setPinned(c.id, !c.pinned);
              }}
            >
              <Pin
                size={12}
                className={`${c.pinned ? 'text-fleet-accent' : 'text-fleet-text-muted'} hover:text-fleet-text`}
              />
            </button>
            <button
              aria-label="Export conversation"
              title="Export conversation"
              onClick={(e) => {
                e.stopPropagation();
                void exportConversation(c.id);
              }}
            >
              <Download size={12} className="text-fleet-text-muted hover:text-fleet-text" />
            </button>
            <button
              aria-label="Delete conversation"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                void remove(c.id);
              }}
            >
              <Trash2 size={12} className="text-fleet-text-muted hover:text-fleet-text" />
            </button>
          </span>
        </span>
      </div>
      {c.tags.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-1">
          {c.tags.map((t) => (
            <span
              key={t}
              className="rounded bg-fleet-surface-3 px-1.5 py-0.5 text-[10px] leading-none text-fleet-text-muted"
            >
              {t}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

export function ConversationList(): React.JSX.Element {
  const conversations = useChatStore((s) => s.conversations);
  const create = useChatStore((s) => s.newConversation);
  const select = useChatStore((s) => s.selectConversation);
  const sort = useChatStore((s) => s.conversationSort);
  const searchQuery = useChatStore((s) => s.searchQuery);
  const searchHits = useChatStore((s) => s.searchHits);
  const search = useChatStore((s) => s.search);
  const clearSearch = useChatStore((s) => s.clearSearch);

  // Pinned conversations float into their own section. The remainder is grouped by
  // recency ('recent' sort) or shown as one flat A→Z list ('alphabetical' sort).
  const { pinned, groups, alpha } = useMemo(() => {
    const pin = conversations.filter((c) => c.pinned);
    const rest = conversations.filter((c) => !c.pinned);
    if (sort === 'alphabetical') {
      const byTitle = (a: ChatConversation, b: ChatConversation): number =>
        a.title.localeCompare(b.title);
      return { pinned: [...pin].sort(byTitle), groups: [], alpha: [...rest].sort(byTitle) };
    }
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const byBucket = new Map<string, ChatConversation[]>();
    // `rest` is already updated_at DESC from the store, so each bucket stays newest-first.
    for (const c of rest) {
      const b = bucketOf(c.updatedAt, startOfToday);
      const list = byBucket.get(b);
      if (list) list.push(c);
      else byBucket.set(b, [c]);
    }
    const grouped = BUCKET_ORDER.map((label) => ({
      label,
      items: byBucket.get(label) ?? []
    })).filter((g) => g.items.length > 0);
    return { pinned: pin, groups: grouped, alpha: [] as ChatConversation[] };
  }, [conversations, sort]);

  return (
    <div className="flex h-full w-64 flex-col border-r border-fleet-border bg-fleet-surface">
      <button
        onClick={() => void create()}
        className="m-2 flex items-center justify-center gap-2 rounded-md border border-fleet-border bg-fleet-surface-2 px-3 py-2 text-sm font-medium text-fleet-text transition-colors hover:bg-fleet-surface-3"
      >
        <Plus size={15} /> New chat
      </button>
      <div className="mx-2 mb-1 flex items-center gap-1.5 rounded-md border border-fleet-border bg-fleet-surface-2 px-2.5 transition-colors focus-within:border-fleet-border-strong">
        <Search size={13} className="shrink-0 text-fleet-text-muted" />
        <input
          value={searchQuery}
          onChange={(e) => void search(e.target.value)}
          placeholder="Search chats…"
          className="min-w-0 flex-1 bg-transparent py-2 text-xs text-fleet-text outline-none placeholder:text-fleet-text-muted"
        />
        {searchQuery && (
          <button aria-label="Clear search" onClick={clearSearch}>
            <X size={13} className="text-fleet-text-muted hover:text-fleet-text" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {searchHits !== null ? (
          searchHits.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-fleet-text-subtle">No matches.</p>
          ) : (
            searchHits.map((h) => (
              <button
                key={h.conversationId}
                onClick={() => void select(h.conversationId)}
                className="block w-full border-b border-fleet-border/40 px-3 py-2 text-left transition-colors hover:bg-fleet-surface-2/50"
              >
                <span className="block truncate text-sm text-fleet-text">{h.title}</span>
                <span className="mt-0.5 line-clamp-2 text-[11px] text-fleet-text-muted">
                  {h.snippet}
                </span>
              </button>
            ))
          )
        ) : conversations.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-fleet-text-subtle">No chats yet.</p>
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                <SectionHeader label="Pinned" />
                {pinned.map((c) => (
                  <Row key={c.id} c={c} />
                ))}
              </>
            )}
            {sort === 'alphabetical'
              ? alpha.map((c) => <Row key={c.id} c={c} />)
              : groups.map((g) => (
                  <div key={g.label}>
                    <SectionHeader label={g.label} />
                    {g.items.map((c) => (
                      <Row key={c.id} c={c} />
                    ))}
                  </div>
                ))}
          </>
        )}
      </div>
    </div>
  );
}
