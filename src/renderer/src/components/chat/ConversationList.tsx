import { Plus, Trash2, GitBranch, Download } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';

export function ConversationList(): React.JSX.Element {
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const select = useChatStore((s) => s.selectConversation);
  const create = useChatStore((s) => s.newConversation);
  const remove = useChatStore((s) => s.deleteConversation);
  const exportConversation = useChatStore((s) => s.exportConversation);

  return (
    <div className="flex h-full w-56 flex-col border-r border-fleet-border bg-fleet-surface">
      <button
        onClick={() => void create()}
        className="m-2 flex items-center gap-2 rounded bg-fleet-surface-2 px-3 py-1.5 text-sm text-fleet-text hover:bg-fleet-surface-3"
      >
        <Plus size={14} /> New chat
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversations.map((c) => (
          <div
            key={c.id}
            role="button"
            tabIndex={0}
            onClick={() => void select(c.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void select(c.id);
              }
            }}
            className={`group flex cursor-pointer items-center justify-between py-2 pr-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-fleet-border-strong ${
              c.parentConversationId ? 'pl-6' : 'pl-3'
            } ${
              c.id === activeId
                ? 'bg-fleet-surface-2 text-fleet-text'
                : 'text-fleet-text-secondary hover:bg-fleet-surface-2'
            }`}
            title={c.parentConversationId ? 'Branched conversation' : undefined}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {c.parentConversationId && (
                <GitBranch size={12} className="shrink-0 text-fleet-text-muted" />
              )}
              <span className="truncate">{c.title}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
              <button
                aria-label="Export conversation"
                title="Export conversation"
                onClick={(e) => {
                  e.stopPropagation();
                  void exportConversation(c.id);
                }}
              >
                <Download size={13} className="text-fleet-text-muted hover:text-fleet-text" />
              </button>
              <button
                aria-label="Delete conversation"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(c.id);
                }}
              >
                <Trash2 size={13} className="text-fleet-text-muted hover:text-fleet-text" />
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
