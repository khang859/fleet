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
  Copy,
  FileCode,
  ArrowDown,
  AlertTriangle,
  RefreshCw,
  Trash2
} from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { usePresence } from '../../hooks/use-presence';
import { streamAnnouncement } from './stream-announce';
import { classifyStreamError } from './stream-error';
import type { ChatMessage } from '../../../../shared/chat-types';
import { extractArtifacts } from '../../../../shared/chat-artifacts';
import { ChatImage } from './ChatImage';
import { GeneratingSkeleton } from './GeneratingSkeleton';
import { ToolStatusPill } from './ToolStatusPill';
import { ToolCallCard } from './ToolCallCard';
import { ChatMarkdown } from './ChatMarkdown';
import { MessageUsage } from './UsageMeter';
import { messageEnterAssistant, messageEnterUser } from '../../lib/motion';

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
        className="focus-ring rounded p-0.5 hover:text-fleet-text disabled:opacity-30"
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
        className="focus-ring rounded p-0.5 hover:text-fleet-text disabled:opacity-30"
      >
        <ChevronRight size={12} />
      </button>
    </div>
  );
}

/** Format ms as a compact thought-time label ("X.Xs" under 10s, else "Xs"). */
function formatThoughtTime(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/**
 * Collapsible chain-of-thought panel, always rendered ABOVE the answer (never
 * inline in the body). While the model is thinking it auto-expands with a shimmer
 * "Thinking…" label + live timer; once the answer starts — or on a finalized
 * message — it collapses to a static "Thought for Xs" disclosure that can be
 * re-expanded. Renders nothing for models that emit no reasoning.
 */
function ReasoningPanel({
  text,
  thinking,
  startAt,
  durationMs
}: {
  text: string;
  thinking: boolean;
  /** Epoch ms the reasoning began — drives the live timer while thinking. */
  startAt?: number;
  /** Final reasoning duration — shown once thinking has stopped. */
  durationMs?: number;
}): React.JSX.Element {
  // null = follow the auto default (expanded while thinking); a boolean = the
  // user took control via the disclosure toggle.
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? thinking;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!thinking || startAt == null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [thinking, startAt]);
  const elapsedMs = thinking && startAt != null ? now - startAt : (durationMs ?? 0);

  return (
    <div className="mb-2 w-full">
      <button
        type="button"
        onClick={() => setUserToggled(!expanded)}
        aria-expanded={expanded}
        className="focus-ring flex items-center gap-1.5 rounded text-xs text-fleet-text-muted hover:text-fleet-text"
      >
        <ChevronRight size={12} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
        {thinking ? (
          <span className="chat-shimmer-text font-medium">
            Thinking… {formatThoughtTime(elapsedMs)}
          </span>
        ) : (
          <span>Thought for {formatThoughtTime(elapsedMs)}</span>
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 border-l-2 border-fleet-border pl-3 text-xs leading-relaxed whitespace-pre-wrap text-fleet-text-secondary">
          {text}
        </div>
      )}
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
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const openArtifact = useChatStore((s) => s.openArtifact);
  const activeArtifact = useChatStore((s) => s.activeArtifact);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const confirmTimer = useRef<number | null>(null);
  useEffect(() => () => window.clearTimeout(copyTimer.current ?? undefined), []);
  useEffect(() => () => window.clearTimeout(confirmTimer.current ?? undefined), []);

  // Two-click guard: the first click arms the delete (and disarms after 3s);
  // the second within that window removes the turn and its replies.
  const onDelete = (): void => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      window.clearTimeout(confirmTimer.current ?? undefined);
      confirmTimer.current = window.setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    window.clearTimeout(confirmTimer.current ?? undefined);
    setConfirmDelete(false);
    void deleteMessage(message.id);
  };

  const copy = (): void => {
    void navigator.clipboard.writeText(content);
    setCopied(true);
    window.clearTimeout(copyTimer.current ?? undefined);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };
  const sentAt = new Date(message.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

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
    <div
      className={`group flex flex-col ${
        isUser ? `items-end ${messageEnterUser}` : `items-start ${messageEnterAssistant}`
      }`}
    >
      <div
        className={
          isUser
            ? 'w-fit max-w-[85%] rounded-lg bg-fleet-surface-2 px-4 py-3 text-sm text-fleet-text'
            : 'w-full max-w-[68ch] text-sm leading-relaxed text-fleet-text'
        }
      >
        {!isUser && message.reasoning && (
          <ReasoningPanel
            text={message.reasoning}
            thinking={false}
            durationMs={message.reasoningMs ?? 0}
          />
        )}
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
        <div className="chat-actions mt-1 flex items-center gap-2">
          <VariantPager message={message} />
          <button
            aria-label={copied ? 'Copied' : 'Copy message'}
            onClick={copy}
            className="focus-ring rounded p-0.5 text-fleet-text-muted hover:text-fleet-text"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
          {isUser && (
            <button
              aria-label="Edit message"
              disabled={streaming}
              onClick={startEdit}
              className="focus-ring rounded p-0.5 text-fleet-text-muted hover:text-fleet-text disabled:opacity-30"
            >
              <Pencil size={12} />
            </button>
          )}
          {!isUser && (
            <button
              aria-label="Regenerate response"
              disabled={streaming}
              onClick={() => void regenerate(message.id, model)}
              className="focus-ring rounded p-0.5 text-fleet-text-muted hover:text-fleet-text disabled:opacity-30"
            >
              <RotateCcw size={12} />
            </button>
          )}
          <button
            aria-label="Fork conversation from here"
            title="Branch from here"
            disabled={streaming}
            onClick={() => void forkConversation(message.id)}
            className="focus-ring rounded p-0.5 text-fleet-text-muted hover:text-fleet-text disabled:opacity-30"
          >
            <GitBranch size={12} />
          </button>
          <button
            aria-label={confirmDelete ? 'Confirm delete' : 'Delete message'}
            title={confirmDelete ? 'Click again to delete' : 'Delete message and replies'}
            disabled={streaming}
            onClick={onDelete}
            className={`focus-ring rounded p-0.5 disabled:opacity-30 ${
              confirmDelete ? 'text-red-400' : 'text-fleet-text-muted hover:text-fleet-text'
            }`}
          >
            <Trash2 size={12} />
          </button>
          {/* Quiet, non-distracting metadata: send time, plus the model on
              assistant replies. Revealed with the action bar (hover/focus). */}
          <span className="text-[11px] text-fleet-text-subtle">{sentAt}</span>
          {!isUser && (
            <span className="max-w-[180px] truncate text-[11px] text-fleet-text-subtle">
              {model}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Floating "Jump to latest" pill — shown only when the user has scrolled away from the bottom. */
function JumpToLatest(): React.JSX.Element | null {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  // Keep mounted through the fade-out so the pill doesn't blink in/out.
  const { mounted, state } = usePresence(!isAtBottom, 150);
  if (!mounted) return null;
  return (
    <button
      type="button"
      aria-label="Jump to latest"
      onClick={() => void scrollToBottom()}
      className={`focus-ring absolute bottom-4 right-6 flex items-center gap-1 rounded-full bg-fleet-surface-3 px-3 py-1.5 text-xs text-fleet-text shadow hover:bg-fleet-surface-2 ${
        state === 'open' ? 'animate-in fade-in' : 'animate-out fade-out'
      }`}
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
/** Pre-first-token waiting state: a shimmer "Thinking…" label. Static under
 *  prefers-reduced-motion (the shimmer is neutralized in index.css). Replaces the
 *  old three-dot wave. The active tool phase (Searching…, Reading file…, etc.) is
 *  surfaced by the sibling ToolStatusPill / GeneratingSkeleton below, so it is not
 *  duplicated here. */
function WaitingIndicator(): React.JSX.Element {
  return (
    <div className="py-1" aria-hidden="true">
      <span className="chat-shimmer-text text-sm font-medium">Thinking…</span>
    </div>
  );
}

function StreamingMessage(): React.JSX.Element {
  const streamingText = useChatStore((s) => s.streamingText) ?? '';
  const streamingReasoning = useChatStore((s) => s.streamingReasoning);
  const hasTokens = streamingText.length > 0;
  const hasReasoning = !!streamingReasoning && streamingReasoning.length > 0;
  const thinking = hasReasoning && !hasTokens;
  // Capture when reasoning began (live timer) and freeze its duration once the
  // answer starts, so the collapsed "Thought for Xs" label stops climbing.
  const startRef = useRef<number | null>(null);
  if (hasReasoning && startRef.current === null) startRef.current = Date.now();
  const frozenRef = useRef<number | null>(null);
  if (hasTokens && hasReasoning && frozenRef.current === null && startRef.current !== null) {
    frozenRef.current = Date.now() - startRef.current;
  }
  return (
    // aria-live=off: streaming text mutates per flush and must NOT be announced
    // token-by-token; the role=status announcer speaks start/completion instead.
    // Flat full-width assistant prose — matches a finalized assistant Bubble.
    <div className="w-full max-w-[68ch] text-sm leading-relaxed text-fleet-text" aria-live="off">
      {hasReasoning && (
        <ReasoningPanel
          text={streamingReasoning}
          thinking={thinking}
          startAt={startRef.current ?? undefined}
          durationMs={frozenRef.current ?? undefined}
        />
      )}
      {hasTokens ? (
        // Fade the first text in (once, on mount) so the indicator→answer
        // transition is a crossfade rather than a hard cut. Reduced-motion
        // neutralizes `animate-in` in index.css.
        <div className="animate-in fade-in duration-150">
          <ChatMarkdown streaming>{streamingText}</ChatMarkdown>
        </div>
      ) : (
        !hasReasoning && <WaitingIndicator />
      )}
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
  );
}

/** Pulsing placeholder shown during the brief async gap while a conversation's
 *  messages load, so switching conversations never flashes an empty pane. */
function MessagesSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="h-3 w-24 animate-pulse rounded bg-fleet-surface-3" />
          <div className="h-3 w-full animate-pulse rounded bg-fleet-surface-2" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-fleet-surface-2" />
        </div>
      ))}
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
  const messagesLoading = useChatStore((s) => s.messagesLoading);
  const status = useChatStore((s) => s.status);
  const toolStatus = useChatStore((s) => s.toolStatus);
  const permissionRequests = useChatStore((s) => s.permissionRequests);
  const decidePermission = useChatStore((s) => s.decidePermission);
  const reduced = useReducedMotion();
  const animation: ScrollBehavior = reduced ? 'instant' : 'smooth';

  return (
    <StickToBottom className="relative min-h-0 flex-1" resize={animation} initial={animation}>
      <StickToBottom.Content role="log" aria-label="Conversation" aria-busy={isStreaming}>
        {/* Centered reading column; turns separated by whitespace (no dividers),
            generous bottom padding so the last reply clears the composer. */}
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
          {messagesLoading && messages.length === 0 && <MessagesSkeleton />}
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
          {status === 'streaming' &&
            toolStatus?.state === 'generating' &&
            (toolStatus.kind === 'image' ? (
              <GeneratingSkeleton label={toolStatus.label} />
            ) : (
              <ToolStatusPill label={toolStatus.label} />
            ))}
          {toolStatus?.state === 'error' && (
            <div className="text-sm text-red-400">
              {toolStatus.kind === 'image' ? 'Image error' : 'Tool error'}:{' '}
              {toolStatus.error ?? toolStatus.label}
            </div>
          )}
          {status === 'error' && <StreamError model={model} />}
        </div>
      </StickToBottom.Content>
      <ReengageOnNewStream animation={animation} />
      <StreamAnnouncer />
      <JumpToLatest />
    </StickToBottom>
  );
}
