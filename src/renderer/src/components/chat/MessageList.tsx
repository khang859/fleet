import { useEffect, useRef, useState } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import {
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Pencil,
  RotateCcw,
  X,
  Check,
  FileCode,
  ArrowDown,
  AlertTriangle,
  RefreshCw
} from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { streamAnnouncement } from './stream-announce';
import { classifyStreamError } from './stream-error';
import type { ChatMessage } from '../../../../shared/chat-types';
import { extractArtifacts } from '../../../../shared/chat-artifacts';
import { ChatImage } from './ChatImage';
import { GeneratingSkeleton } from './GeneratingSkeleton';
import { ToolCallCard } from './ToolCallCard';
import { ChatMarkdown } from './ChatMarkdown';
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
  const openArtifact = useChatStore((s) => s.openArtifact);
  const activeArtifact = useChatStore((s) => s.activeArtifact);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);

  const artifacts = isUser ? [] : extractArtifacts(content);

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
          <ChatMarkdown>{content}</ChatMarkdown>
        )}
        {images !== undefined && images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((img) => (
              <ChatImage key={img.ref} image={img} />
            ))}
          </div>
        )}
      </div>
      {!editing && artifacts.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {artifacts.map((a) => {
            const open =
              activeArtifact?.messageId === message.id && activeArtifact.index === a.index;
            return (
              <button
                key={a.index}
                onClick={() => openArtifact({ ...a, messageId: message.id })}
                className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${
                  open
                    ? 'border-fleet-accent/60 bg-fleet-accent/15 text-fleet-text'
                    : 'border-fleet-border bg-fleet-surface-2 text-fleet-text-secondary hover:text-fleet-text'
                }`}
              >
                <FileCode size={13} className="text-fleet-text-muted" />
                <span className="max-w-40 truncate">{a.title}</span>
              </button>
            );
          })}
        </div>
      )}
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

/** Floating "Jump to latest" pill — shown only when the user has scrolled away from the bottom. */
function JumpToLatest(): React.JSX.Element | null {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      type="button"
      aria-label="Jump to latest"
      onClick={() => void scrollToBottom()}
      className="absolute bottom-4 right-6 flex items-center gap-1 rounded-full bg-fleet-surface-3 px-3 py-1.5 text-xs text-fleet-text shadow hover:bg-fleet-surface-2"
    >
      <ArrowDown size={12} /> Jump to latest
    </button>
  );
}

/**
 * Single always-mounted polite live region. Announces only state transitions
 * (start / completion / error) so a screen reader speaks them once each rather
 * than re-reading streaming text on every token.
 */
function StreamAnnouncer(): React.JSX.Element {
  const status = useChatStore((s) => s.status);
  const error = useChatStore((s) => s.error);
  const [message, setMessage] = useState('');
  const prevStatus = useRef(status);
  useEffect(() => {
    const next = streamAnnouncement(prevStatus.current, status, error);
    prevStatus.current = status;
    if (next !== null) setMessage(next);
  }, [status, error]);
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {message}
    </div>
  );
}

/** Re-engages stick-to-bottom whenever a new stream starts, even if the user had scrolled up. */
function ReengageOnNewStream({ animation }: { animation: ScrollBehavior }): null {
  const { scrollToBottom } = useStickToBottomContext();
  const streamId = useChatStore((s) => s.streamId);
  useEffect(() => {
    if (streamId) void scrollToBottom(animation);
  }, [streamId, scrollToBottom, animation]);
  return null;
}

/**
 * The in-flight assistant message. Isolated into its own component so that
 * throttled token updates re-render only this node — not MessageList or any
 * finalized history Bubble (which would otherwise re-parse all markdown).
 */
function StreamingMessage(): React.JSX.Element {
  const streamingText = useChatStore((s) => s.streamingText) ?? '';
  return (
    // aria-live=off: streaming text mutates per flush and must NOT be announced
    // token-by-token; the role=status announcer speaks start/completion instead.
    <div className="flex justify-start px-4 py-2" aria-live="off">
      <div className="max-w-[80%] rounded-lg bg-fleet-surface-2 px-3 py-2 text-sm text-fleet-text">
        <ChatMarkdown streaming>{streamingText || '…'}</ChatMarkdown>
      </div>
    </div>
  );
}

/**
 * Inline failed-turn error: plain-language, classified (network vs auth/quota),
 * attached where the assistant reply would be. Offers a scoped "Try again" that
 * re-streams the last user prompt — not a global retry.
 */
function StreamError({ model }: { model: string }): React.JSX.Element {
  const error = useChatStore((s) => s.error);
  const retryLastTurn = useChatStore((s) => s.retryLastTurn);
  const info = classifyStreamError(error);
  return (
    <div className="px-4 py-2">
      <div className="flex max-w-[80%] items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-400" />
        <div className="min-w-0">
          <div className="font-medium text-fleet-text">{info.title}</div>
          <div className="mt-0.5 text-fleet-text-secondary">{info.detail}</div>
          {info.retryable && (
            <button
              type="button"
              onClick={() => void retryLastTurn(model)}
              className="mt-1.5 flex items-center gap-1 rounded bg-fleet-surface-3 px-2 py-1 text-xs text-fleet-text hover:bg-fleet-surface-2"
            >
              <RefreshCw size={12} /> Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type Props = { defaultModel: string; showUsage: boolean };

export function MessageList({ defaultModel, showUsage }: Props): React.JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const model = useChatStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.model ?? defaultModel
  );
  // Subscribe to a stable boolean, not the streaming text itself, so token
  // updates don't re-render the whole list (see StreamingMessage).
  const isStreaming = useChatStore((s) => s.streamingText !== null);
  const status = useChatStore((s) => s.status);
  const toolStatus = useChatStore((s) => s.toolStatus);
  const permissionRequests = useChatStore((s) => s.permissionRequests);
  const decidePermission = useChatStore((s) => s.decidePermission);
  const reduced = useReducedMotion();
  const animation: ScrollBehavior = reduced ? 'instant' : 'smooth';

  return (
    <StickToBottom
      className="relative min-h-0 flex-1"
      resize={animation}
      initial={animation}
    >
      <StickToBottom.Content
        className="py-2"
        role="log"
        aria-label="Conversation"
        aria-busy={isStreaming}
      >
        {messages.map((m) => (
          <Bubble key={m.id} message={m} model={model} showUsage={showUsage} />
        ))}
        {isStreaming && <StreamingMessage />}
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
        {status === 'error' && <StreamError model={model} />}
      </StickToBottom.Content>
      <ReengageOnNewStream animation={animation} />
      <StreamAnnouncer />
      <JumpToLatest />
    </StickToBottom>
  );
}
