import { useMemo, useState } from 'react';
import {
  Plus,
  Trash2,
  GitBranch,
  Download,
  Pin,
  FolderInput,
  Search,
  X,
  ChevronRight,
  ChevronDown
} from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import type { ChatConversation } from '../../../../shared/chat-types';

/** A single conversation row with its hover actions. */
function Row({ c, indent }: { c: ChatConversation; indent: boolean }): React.JSX.Element {
  const activeId = useChatStore((s) => s.activeId);
  const select = useChatStore((s) => s.selectConversation);
  const remove = useChatStore((s) => s.deleteConversation);
  const exportConversation = useChatStore((s) => s.exportConversation);
  const setPinned = useChatStore((s) => s.setConversationPinned);
  const setFolder = useChatStore((s) => s.setConversationFolder);

  const assignFolder = (): void => {
    const next = window.prompt('Folder name (empty to remove):', c.folder ?? '');
    if (next !== null) void setFolder(c.id, next.trim() || null);
  };

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
      className={`group flex cursor-pointer flex-col py-2 pr-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-fleet-border-strong ${
        indent || c.parentConversationId ? 'pl-6' : 'pl-3'
      } ${
        c.id === activeId
          ? 'bg-fleet-surface-2 text-fleet-text'
          : 'text-fleet-text-secondary hover:bg-fleet-surface-2'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="flex min-w-0 items-center gap-1.5">
          {c.pinned && (
            <Pin size={11} className="shrink-0 rotate-45 fill-current text-fleet-accent" />
          )}
          {c.parentConversationId && (
            <GitBranch size={12} className="shrink-0 text-fleet-text-muted" />
          )}
          <span className="truncate">{c.title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
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
            aria-label="Move to folder"
            title="Move to folder"
            onClick={(e) => {
              e.stopPropagation();
              assignFolder();
            }}
          >
            <FolderInput size={12} className="text-fleet-text-muted hover:text-fleet-text" />
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
            onClick={(e) => {
              e.stopPropagation();
              void remove(c.id);
            }}
          >
            <Trash2 size={12} className="text-fleet-text-muted hover:text-fleet-text" />
          </button>
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleFolder = (name: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // Apply the default sort (pinned always float first, preserved from the store order).
  const sorted = useMemo(() => {
    const list = [...conversations];
    if (sort === 'alphabetical') {
      list.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return a.title.localeCompare(b.title);
      });
    }
    return list;
  }, [conversations, sort]);

  const pinned = sorted.filter((c) => c.pinned);
  const rest = sorted.filter((c) => !c.pinned);
  const folders = useMemo(
    () =>
      [...new Set(rest.map((c) => c.folder).filter((f): f is string => !!f))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [rest]
  );
  const ungrouped = rest.filter((c) => !c.folder);

  return (
    <div className="flex h-full w-56 flex-col border-r border-fleet-border bg-fleet-surface">
      <button
        onClick={() => void create()}
        className="m-2 mb-1 flex items-center gap-2 rounded bg-fleet-surface-2 px-3 py-1.5 text-sm text-fleet-text hover:bg-fleet-surface-3"
      >
        <Plus size={14} /> New chat
      </button>
      <div className="mx-2 mb-1 flex items-center gap-1 rounded border border-fleet-border bg-fleet-surface-2 px-2">
        <Search size={12} className="shrink-0 text-fleet-text-muted" />
        <input
          value={searchQuery}
          onChange={(e) => void search(e.target.value)}
          placeholder="Search messages…"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-fleet-text outline-none placeholder:text-fleet-text-muted"
        />
        {searchQuery && (
          <button aria-label="Clear search" onClick={clearSearch}>
            <X size={12} className="text-fleet-text-muted hover:text-fleet-text" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {searchHits !== null ? (
          searchHits.length === 0 ? (
            <p className="px-3 py-2 text-xs text-fleet-text-muted">No matches.</p>
          ) : (
            searchHits.map((h) => (
              <button
                key={h.conversationId}
                onClick={() => void select(h.conversationId)}
                className="block w-full px-3 py-2 text-left hover:bg-fleet-surface-2"
              >
                <span className="block truncate text-sm text-fleet-text">{h.title}</span>
                <span className="line-clamp-2 text-[11px] text-fleet-text-muted">{h.snippet}</span>
              </button>
            ))
          )
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                <p className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-fleet-text-muted">
                  Pinned
                </p>
                {pinned.map((c) => (
                  <Row key={c.id} c={c} indent={false} />
                ))}
              </>
            )}
            {folders.map((folder) => (
              <div key={folder}>
                <button
                  onClick={() => toggleFolder(folder)}
                  className="flex w-full items-center gap-1 px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-fleet-text-muted hover:text-fleet-text"
                >
                  {collapsed.has(folder) ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                  {folder}
                </button>
                {!collapsed.has(folder) &&
                  rest
                    .filter((c) => c.folder === folder)
                    .map((c) => <Row key={c.id} c={c} indent />)}
              </div>
            ))}
            {ungrouped.map((c) => (
              <Row key={c.id} c={c} indent={false} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
