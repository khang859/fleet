import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { ChevronLeft, ChevronRight, GitBranch, Pencil, RotateCcw, X, Check } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import type { ChatMessage } from '../../../../shared/chat-types';
import { ChatImage } from './ChatImage';
import { GeneratingSkeleton } from './GeneratingSkeleton';
import { ToolCallCard } from './ToolCallCard';
import { CodeBlock } from '../markdown/CodeBlock';
import { MessageUsage } from './UsageMeter';

/** ‹ 2 / 3 › pager that switches between sibling attempts of a turn. */
function VariantPager({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const selectVariant = useChatStore((s) => s.selectVariant);
  const v = message.variants;
  if (!v) return null;
  const go = (delta: number): void => {
    const next = v.ids[v.index - 1 + delta];
    if (next) void selectVariant(next);
  };
  return (
    <div className="flex items-center gap-1 text-[11px] text-fleet-text-muted">
      <button
        aria-label="Previous version"
        disabled={v.index <= 1}
        onClick={() => go(-1)}
        className="rounded p-0.5 hover:text-fleet-text disabled:opacity-30"
      >
        <ChevronLeft size={12} />
      </button>
      <span>
        {v.index} / {v.total}
      </span>
      <button
        aria-label="Next version"
        disabled={v.index >= v.total}
        onClick={() => go(1)}
        className="rounded p-0.5 hover:text-fleet-text disabled:opacity-30"
      >
        <ChevronRight size={12} />
      </button>
    </div>
  );
}

function Bubble({
  message,
  model,
  showUsage
}: {
  message: ChatMessage;
  model: string;
  showUsage: boolean;
}): React.JSX.Element {
  const { role, content, images } = message;
  const isUser = role === 'user';
  const streaming = useChatStore((s) => s.status === 'streaming');
  const regenerate = useChatStore((s) => s.regenerate);
  const editMessage = useChatStore((s) => s.editMessage);
  const forkConversation = useChatStore((s) => s.forkConversation);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);

  const startEdit = (): void => {
    setDraft(content);
    setEditing(true);
  };
  const saveEdit = (): void => {
    setEditing(false);
    if (draft.trim() && draft !== content) void editMessage(message.id, draft, model);
  };

  return (
    <div className={`group flex flex-col ${isUser ? 'items-end' : 'items-start'} px-4 py-2`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-fleet-accent/20 text-fleet-text' : 'bg-fleet-surface-2 text-fleet-text'
        }`}
      >
        {editing ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(10, draft.split('\n').length + 1)}
              className="w-72 max-w-full resize-none rounded border border-fleet-border bg-fleet-surface-2 px-2 py-1 text-sm text-fleet-text outline-none"
              autoFocus
            />
            <div className="flex justify-end gap-1">
              <button
                onClick={() => setEditing(false)}
                className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-fleet-text-muted hover:text-fleet-text"
              >
                <X size={12} /> Cancel
              </button>
              <button
                onClick={saveEdit}
                className="flex items-center gap-1 rounded bg-fleet-accent/80 px-2 py-0.5 text-xs text-white"
              >
                <Check size={12} /> Save &amp; submit
              </button>
            </div>
          </div>
        ) : (
          <div className="prose prose-invert max-w-[70ch] prose-pre:bg-fleet-surface-3">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[[rehypeHighlight, { detect: true }]]}
              components={{ pre: CodeBlock }}
            >
              {content}
            </ReactMarkdown>
          </div>
        )}
        {images !== undefined && images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((img) => (
              <ChatImage key={img.ref} image={img} />
            ))}
          </div>
        )}
      </div>
      {!editing && showUsage && message.usage && (
        <div className="mt-0.5">
          <MessageUsage usage={message.usage} />
        </div>
      )}
      {!editing && (
        <div className="mt-1 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
          <VariantPager message={message} />
          {isUser && (
            <button
              aria-label="Edit message"
              disabled={streaming}
              onClick={startEdit}
              className="rounded p-0.5 text-fleet-text-muted hover:text-fleet-text disabled:opacity-30"
            >
              <Pencil size={12} />
            </button>
          )}
          {!isUser && (
            <button
              aria-label="Regenerate response"
              disabled={streaming}
              onClick={() => void regenerate(message.id, model)}
              className="rounded p-0.5 text-fleet-text-muted hover:text-fleet-text disabled:opacity-30"
            >
              <RotateCcw size={12} />
            </button>
          )}
          <button
            aria-label="Fork conversation from here"
            title="Branch from here"
            disabled={streaming}
            onClick={() => void forkConversation(message.id)}
            className="rounded p-0.5 text-fleet-text-muted hover:text-fleet-text disabled:opacity-30"
          >
            <GitBranch size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

type Props = { defaultModel: string; showUsage: boolean };

export function MessageList({ defaultModel, showUsage }: Props): React.JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const model = useChatStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.model ?? defaultModel
  );
  const streamingText = useChatStore((s) => s.streamingText);
  const status = useChatStore((s) => s.status);
  const error = useChatStore((s) => s.error);
  const toolStatus = useChatStore((s) => s.toolStatus);
  const permissionRequests = useChatStore((s) => s.permissionRequests);
  const decidePermission = useChatStore((s) => s.decidePermission);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = (): void => {
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (atBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, atBottom]);

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto py-2">
      {messages.map((m) => (
        <Bubble key={m.id} message={m} model={model} showUsage={showUsage} />
      ))}
      {streamingText !== null && (
        <div className="flex justify-start px-4 py-2">
          <div className="max-w-[80%] rounded-lg bg-fleet-surface-2 px-3 py-2 text-sm text-fleet-text">
            <div className="prose prose-invert max-w-[70ch] prose-pre:bg-fleet-surface-3">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                components={{ pre: CodeBlock }}
              >
                {streamingText || '…'}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}
      {permissionRequests.map((req) => (
        <ToolCallCard
          key={req.requestId}
          request={req}
          onDecide={(outcome) => void decidePermission(req.requestId, outcome)}
        />
      ))}
      {status === 'streaming' && toolStatus?.state === 'generating' && (
        <GeneratingSkeleton label={toolStatus.label} />
      )}
      {toolStatus?.state === 'error' && (
        <div className="px-4 py-2 text-sm text-red-400">
          Image error: {toolStatus.error ?? toolStatus.label}
        </div>
      )}
      {status === 'error' && <div className="px-4 py-2 text-sm text-red-400">Error: {error}</div>}
      {!atBottom && (
        <button
          type="button"
          onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
          className="fixed bottom-24 right-6 rounded-full bg-fleet-surface-3 px-3 py-1.5 text-xs text-fleet-text shadow hover:bg-fleet-surface-2"
        >
          Jump to latest ↓
        </button>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
