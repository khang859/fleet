import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, FoldVertical, Square, TriangleAlert } from 'lucide-react';
import type {
  AgentMessage,
  AgentPermissionAsk,
  AgentPermissionOutcome
} from '../../../../shared/agent-types';
import { messageText } from '../../../../shared/agent-types';
import { canCompact } from '../../../../shared/agent-context';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentActivity } from './AgentActivity';
import { AgentToolRow } from './AgentToolRow';
import { AgentPermissionRow } from './AgentPermissionRow';
import { reasoningLabel } from './activity';
import { AgentContextMeter } from './AgentContextMeter';
import { useAgentStore } from '../../store/agent-store';
import { useSettingsStore } from '../../store/settings-store';
import { shortenPath } from '../../lib/shorten-path';

/**
 * The agent's transcript and composer. One streamed turn at a time, which may
 * read its way around the folder before it answers.
 */
export function AgentThread({ paneId, cwd }: { paneId: string; cwd: string }): React.JSX.Element {
  const thread = useAgentStore((s) => s.threads[paneId]);
  const send = useAgentStore((s) => s.send);
  const cancel = useAgentStore((s) => s.cancel);
  const compact = useAgentStore((s) => s.compact);
  const catalog = useAgentStore((s) => s.catalog);
  const agent = useSettingsStore((s) => s.settings?.ai.agent ?? null);
  const model = agent?.coding.model ?? null;

  const decidePermission = useAgentStore((s) => s.decidePermission);

  const messages = thread?.messages ?? [];
  const compacting = (thread?.pendingCompact ?? null) !== null;
  const streaming = (thread?.streamId ?? null) !== null;
  const contextTokens = thread?.contextTokens ?? null;
  const ask = thread?.pendingPermission ?? null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {messages.length === 0 ? (
        <EmptyState cwd={cwd} />
      ) : (
        <Transcript
          messages={messages}
          streaming={streaming && !compacting}
          ask={ask}
          onDecide={(outcome) => decidePermission(paneId, outcome)}
        />
      )}

      {thread?.error != null && (
        <div className="mx-auto flex w-full max-w-2xl items-start gap-2 px-4 pb-2 text-xs text-amber-400/90">
          <TriangleAlert size={13} className="mt-px shrink-0" />
          <span>{thread.error}</span>
        </div>
      )}

      {/* One status line for the turn: what the agent is doing on the left, how
          much room it has left on the right. Always rendered while either has
          something to say, so neither appearing shoves the composer down. */}
      {(streaming || contextTokens !== null) && (
        <div className="mx-auto flex w-full max-w-2xl items-center gap-3 px-4 pb-1.5 text-[11px] text-fleet-text-subtle">
          {streaming && (
            <AgentActivity
              last={messages.at(-1)}
              compacting={compacting}
              asking={ask !== null}
              startedAt={thread?.startedAt ?? null}
            />
          )}
          {contextTokens !== null && (
            <span className="ml-auto">
              <AgentContextMeter
                used={contextTokens}
                limit={catalog?.models.find((m) => m.id === model)?.contextLimit ?? null}
                threshold={agent?.compactThreshold ?? null}
                canCompact={!streaming && canCompact(messages)}
                onCompact={() => compact(paneId)}
              />
            </span>
          )}
        </div>
      )}

      <Composer
        disabled={model === null}
        streaming={streaming}
        onSend={(text) => send(paneId, cwd, text)}
        onStop={() => cancel(paneId)}
      />
    </div>
  );
}

function EmptyState({ cwd }: { cwd: string }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
      <span className="text-sm font-medium uppercase tracking-[0.3em] text-fleet-text-subtle">
        Agent
      </span>
      <span className="max-w-full truncate px-4 text-xs text-fleet-text-subtle/70">
        {shortenPath(cwd)}
      </span>
    </div>
  );
}

function Transcript({
  messages,
  streaming,
  ask,
  onDecide
}: {
  messages: AgentMessage[];
  streaming: boolean;
  ask: AgentPermissionAsk | null;
  onDecide: (outcome: AgentPermissionOutcome) => void;
}): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const last = messages.at(-1);

  // Follow the stream. Keyed on the growing text so every delta scrolls.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, last?.parts, last?.reasoning]);

  // A reply keeps growing after React has finished with it: a code block is
  // highlighted asynchronously and lands taller than the space held for it,
  // which is enough to push the end of the answer below the fold - and an
  // answer that finishes on a code block is most of them. So the tail follows
  // the content itself rather than the render that started it.
  useEffect(() => {
    const content = contentRef.current;
    if (content === null) return;

    let height = content.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const grown = content.getBoundingClientRect().height;
      if (grown <= height) {
        height = grown;
        return;
      }
      height = grown;
      endRef.current?.scrollIntoView({ block: 'end' });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div ref={contentRef} className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-5">
        {messages.map((message, i) => (
          <Message
            key={message.id}
            message={message}
            streaming={streaming && i === messages.length - 1}
            ask={ask}
            onDecide={onDecide}
          />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

/**
 * User turns are a bubble, the agent's answer is flat on the page - the reply is
 * the content, not one side of a conversation. Model prose is Markdown, whether
 * it is an answer or a summary; what the user typed and the reasoning channel
 * stay verbatim, since neither is written to be formatted.
 */
function Message({
  message,
  streaming,
  ask,
  onDecide
}: {
  message: AgentMessage;
  streaming: boolean;
  ask: AgentPermissionAsk | null;
  onDecide: (outcome: AgentPermissionOutcome) => void;
}): React.JSX.Element {
  if (message.role === 'summary') return <SummaryCard summary={messageText(message)} />;
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-fleet-surface-2 px-3.5 py-2 text-sm text-fleet-text">
          {messageText(message)}
        </div>
      </div>
    );
  }
  const lastPart = message.parts.length - 1;
  return (
    <div className="flex flex-col gap-2">
      {message.reasoning !== '' && (
        <ReasoningBlock
          text={message.reasoning}
          durationMs={message.reasoningMs}
          // Thinking is worth watching only while it is the sole thing
          // happening; the moment an answer starts, the answer is the point.
          live={streaming && message.parts.length === 0}
        />
      )}
      {/* In the order the turn happened: what it said, what it looked at, and
          what it said about what it found. Keyed by position because that is
          what a part is - text parts have no id, and two of them are only
          distinguishable by where they fall. */}
      {message.parts.map((part, i) =>
        part.type === 'tool' ? (
          // The question takes the row's place: until it is answered there is
          // nothing else that row could be saying.
          ask?.callId === part.call.id ? (
            <AgentPermissionRow key={i} ask={ask} onDecide={onDecide} />
          ) : (
            <AgentToolRow key={i} call={part.call} />
          )
        ) : (
          <div key={i} className="text-fleet-text">
            <AgentMarkdown streaming={streaming && i === lastPart}>{part.text}</AgentMarkdown>
          </div>
        )
      )}
    </div>
  );
}

/**
 * The model's reasoning: open while it is thinking, folded away to a single
 * line once the answer arrives.
 *
 * This is where every AI product has landed - Mistral, Grok and Pi all show
 * the chain of thought live and then collapse it to "Thought for 1m 8s" - and
 * the reason is that the two moments want opposite things. While the model is
 * thinking, the reasoning is the only thing on screen worth reading. Once the
 * answer exists, the reasoning is a wall of text between the question and it.
 * The duration is what survives, because it is the part still worth knowing.
 *
 * A click either way sticks, and from then on the block stops second-guessing
 * the user.
 */
function ReasoningBlock({
  text,
  durationMs,
  live
}: {
  text: string;
  durationMs: number | null;
  live: boolean;
}): React.JSX.Element {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? live;

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        className="flex w-fit items-center gap-1 text-xs text-fleet-text-subtle transition-colors hover:text-fleet-text-muted focus-ring"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        {live ? 'Thinking…' : reasoningLabel(durationMs)}
      </button>
      {open && (
        <div className="border-l-2 border-fleet-border pl-3 text-xs leading-relaxed whitespace-pre-wrap text-fleet-text-muted">
          {text}
        </div>
      )}
    </div>
  );
}

/**
 * What is left of the messages compaction replaced. Collapsed by default: it is
 * background the model reads, not something the user should have to scroll
 * past, but hiding it entirely would mean the transcript quietly lost turns.
 */
function SummaryCard({ summary }: { summary: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-dashed border-fleet-border px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-[11px] uppercase tracking-wider text-fleet-text-subtle transition-colors hover:text-fleet-text-muted focus-ring"
      >
        <FoldVertical size={12} className="shrink-0" />
        Earlier conversation compacted
        <span className="ml-auto normal-case tracking-normal">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="mt-2">
          {/* The summary is model prose like any other, lists and quotes included. */}
          <AgentMarkdown
            streaming={false}
            className="text-xs leading-relaxed text-fleet-text-muted"
          >
            {summary}
          </AgentMarkdown>
        </div>
      )}
    </div>
  );
}

function Composer({
  disabled,
  streaming,
  onSend,
  onStop
}: {
  disabled: boolean;
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the content up to the max height the class caps it at.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = (): void => {
    const trimmed = text.trim();
    if (trimmed === '' || streaming || disabled) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <div className="mx-auto w-full max-w-2xl shrink-0 px-4 pb-4">
      <div className="flex items-end gap-2 rounded-xl border border-fleet-border bg-fleet-surface p-2 focus-within:border-fleet-border-strong">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? 'Choose a coding model in Settings first' : 'Ask the agent…'}
          aria-label="Message the agent"
          className="max-h-48 min-h-6 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-fleet-text outline-none placeholder:text-fleet-text-subtle disabled:cursor-not-allowed"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            title="Stop"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-fleet-surface-3 text-fleet-text transition-colors hover:bg-fleet-surface-2 focus-ring"
          >
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={text.trim() === '' || disabled}
            aria-label="Send"
            title="Send"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg fleet-accent-bg text-white transition-opacity disabled:opacity-30 focus-ring"
          >
            <ArrowUp size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
