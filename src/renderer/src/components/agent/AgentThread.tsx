import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, TriangleAlert } from 'lucide-react';
import type { AgentMessage } from '../../../../shared/agent-types';
import { useAgentStore } from '../../store/agent-store';
import { useSettingsStore } from '../../store/settings-store';
import { shortenPath } from '../../lib/shorten-path';

/**
 * The agent's transcript and composer. One streamed turn at a time, no tools -
 * the thread lives in the renderer and is gone when the pane closes.
 */
export function AgentThread({ paneId, cwd }: { paneId: string; cwd: string }): React.JSX.Element {
  const thread = useAgentStore((s) => s.threads[paneId]);
  const send = useAgentStore((s) => s.send);
  const cancel = useAgentStore((s) => s.cancel);
  const model = useSettingsStore((s) => s.settings?.ai.agent.coding.model ?? null);

  const messages = thread?.messages ?? [];
  const streaming = (thread?.streamId ?? null) !== null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {messages.length === 0 ? (
        <EmptyState cwd={cwd} />
      ) : (
        <Transcript messages={messages} streaming={streaming} />
      )}

      {thread?.error != null && (
        <div className="mx-auto flex w-full max-w-2xl items-start gap-2 px-4 pb-2 text-xs text-amber-400/90">
          <TriangleAlert size={13} className="mt-px shrink-0" />
          <span>{thread.error}</span>
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
  streaming
}: {
  messages: AgentMessage[];
  streaming: boolean;
}): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const last = messages.at(-1);
  // The reply being streamed has nothing in it yet, in either channel.
  const awaitingFirstToken = streaming && last?.content === '' && last.reasoning === '';

  // Follow the stream. Keyed on the growing text so every delta scrolls.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, last?.content, last?.reasoning]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-5">
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {awaitingFirstToken && <span className="text-sm text-fleet-text-muted">Thinking…</span>}
        <div ref={endRef} />
      </div>
    </div>
  );
}

/**
 * User turns are a bubble, the agent's answer is flat on the page - the reply is
 * the content, not one side of a conversation. Text is rendered verbatim;
 * markdown is its own step.
 */
function Message({ message }: { message: AgentMessage }): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-fleet-surface-2 px-3.5 py-2 text-sm text-fleet-text">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {message.reasoning !== '' && (
        <div className="border-l-2 border-fleet-border pl-3 text-xs leading-relaxed whitespace-pre-wrap text-fleet-text-muted">
          {message.reasoning}
        </div>
      )}
      {message.content !== '' && (
        <div className="text-sm leading-relaxed whitespace-pre-wrap text-fleet-text">
          {message.content}
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
