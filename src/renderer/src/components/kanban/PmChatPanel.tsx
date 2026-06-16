import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Bot, RotateCcw, Wrench } from 'lucide-react';
import { usePmChatStore } from '../../store/pm-chat-store';
import type { TranscriptMessage } from '../../../../shared/sessions';
import type { PmProposal } from '../../../../shared/kanban-types';

type Props = {
  boardId: string;
  /** True when the task drawer is open, so the panel parks to its left. */
  shiftLeft: boolean;
};

/** Cron preset bound to the "Daily 9am standup digest" toggle. */
const DAILY_9AM_CRON = '0 9 * * *';

/** Compact one-line label for a tool call, e.g. "kanban_create". */
function toolChips(msg: TranscriptMessage): string[] {
  return msg.blocks.flatMap((b) => (b.type === 'tool_use' ? [b.name] : []));
}

function messageText(msg: TranscriptMessage): string {
  return msg.blocks
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}

export function PmChatPanel({ boardId, shiftLeft }: Props): React.JSX.Element {
  const {
    closePanel,
    loadState,
    send,
    reset,
    applyStatus,
    applyTranscript,
    status,
    error,
    messages
  } = usePmChatStore();
  const [draft, setDraft] = useState('');
  const [proposals, setProposals] = useState<PmProposal[]>([]);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [digestCron, setDigestCron] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.fleet.kanban.getDigestConfig(boardId).then((c) => {
      if (!cancelled) setDigestCron(c.digestCron);
    });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const toggleDigest = useCallback(
    async (enabled: boolean) => {
      const next = enabled ? DAILY_9AM_CRON : null;
      try {
        await window.fleet.kanban.setDigestCron(boardId, next);
        setDigestCron(next);
      } catch {
        // re-sync the checkbox to the persisted value on failure
        const c = await window.fleet.kanban.getDigestConfig(boardId).catch(() => null);
        if (c) setDigestCron(c.digestCron);
      }
    },
    [boardId]
  );

  const refreshProposals = useCallback(async () => {
    setProposals(await window.fleet.kanban.listProposals(boardId));
  }, [boardId]);

  const approve = useCallback(
    async (id: string) => {
      try {
        const updated = await window.fleet.kanban.approveProposal(id);
        setProposalError(updated.status === 'failed' ? (updated.error ?? 'action failed') : null);
      } catch {
        // second click after the proposal already resolved — ignore
      }
      await refreshProposals();
    },
    [refreshProposals]
  );

  const dismiss = useCallback(
    async (id: string) => {
      try {
        await window.fleet.kanban.dismissProposal(id);
        setProposalError(null);
      } catch {
        // best-effort dismiss — ignore
      }
      await refreshProposals();
    },
    [refreshProposals]
  );

  useEffect(() => {
    void loadState(boardId);
    void refreshProposals();
    const offStatus = window.fleet.kanban.onPmStatus((p) => {
      if (p.boardId === boardId) applyStatus(p.status, p.error);
    });
    const offTranscript = window.fleet.kanban.onPmTranscript((p) => {
      if (p.boardId === boardId) {
        applyTranscript(p.messages);
        void refreshProposals();
      }
    });
    return () => {
      offStatus();
      offTranscript();
    };
  }, [boardId, loadState, applyStatus, applyTranscript, refreshProposals]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, status]);

  function handleSend(): void {
    const text = draft.trim();
    if (!text || status === 'thinking') return;
    setDraft('');
    void send(boardId, text);
  }

  const thinking = status === 'thinking';

  return (
    <div
      className={`fixed bottom-0 top-9 z-30 flex w-[380px] flex-col border-l border-neutral-800 bg-neutral-900 shadow-2xl ${
        shiftLeft ? 'right-[420px]' : 'right-0'
      }`}
    >
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <Bot size={14} className="text-emerald-400" />
        <span className="text-xs font-medium text-neutral-200">Board PM</span>
        <div className="flex-1" />
        <button
          onClick={() => {
            if (messages.length === 0 || window.confirm('Start a new conversation?')) {
              void reset(boardId);
            }
          }}
          disabled={thinking}
          className="rounded p-1 text-neutral-500 transition active:scale-90 hover:bg-neutral-800 hover:text-neutral-300 disabled:opacity-40"
          title="New conversation"
        >
          <RotateCcw size={12} />
        </button>
        <button
          onClick={closePanel}
          className="rounded p-1 text-neutral-500 transition active:scale-90 hover:bg-neutral-800 hover:text-neutral-300"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-2">
        {messages.length === 0 && !thinking && (
          <p className="mt-4 text-center text-xs text-neutral-500">
            Talk to your board PM — describe a feature, a bug, or a pile of ideas, and it will shape
            them into tickets.
          </p>
        )}
        {messages.map((m, i) => {
          const text = messageText(m);
          const chips = toolChips(m);
          if (!text && chips.length === 0) return null;
          return (
            <div
              key={i}
              className={`flex flex-col gap-1 ${m.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              {text && (
                <div
                  className={`max-w-[90%] whitespace-pre-wrap rounded-md px-2.5 py-1.5 text-xs ${
                    m.role === 'user'
                      ? 'bg-blue-600/20 text-blue-100'
                      : 'bg-neutral-800 text-neutral-200'
                  }`}
                >
                  {text}
                </div>
              )}
              {chips.map((name, j) => (
                <span
                  key={j}
                  className="inline-flex items-center gap-1 rounded-full border border-neutral-700 bg-neutral-950 px-2 py-0.5 text-[10px] text-neutral-400"
                >
                  <Wrench size={9} /> {name}
                </span>
              ))}
            </div>
          );
        })}
        {thinking && (
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            Thinking…
          </div>
        )}
        {status === 'error' && error && (
          <div className="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 text-[11px] text-red-300">
            {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {(proposals.length > 0 || proposalError) && (
        <div className="flex flex-col gap-2 border-t border-neutral-800 px-3 py-2">
          {proposals.map((p) => (
            <div
              key={p.id}
              className="rounded border border-neutral-700 bg-neutral-800/40 px-2.5 py-2 text-xs"
            >
              <div className="text-neutral-200">
                <span className="font-medium">{p.kind.replace(/_/g, ' ')}</span> · {p.targetId}
              </div>
              <div className="text-[11px] text-neutral-500">{p.rationale}</div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => void approve(p.id)}
                  className="rounded bg-blue-600 px-2 py-1 text-[11px] text-white transition active:scale-95 hover:bg-blue-500"
                >
                  Approve
                </button>
                <button
                  onClick={() => void dismiss(p.id)}
                  className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-400 transition active:scale-95 hover:bg-neutral-800"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
          {proposalError && (
            <div className="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 text-[11px] text-red-300">
              {proposalError}
            </div>
          )}
        </div>
      )}

      <div className="border-t border-neutral-800 px-3 py-2">
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={digestCron === DAILY_9AM_CRON}
            onChange={(e) => void toggleDigest(e.target.checked)}
          />
          Daily 9am standup digest
        </label>
      </div>

      <div className="border-t border-neutral-800 p-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={
            thinking
              ? 'PM is thinking…'
              : 'Message the PM… (Enter to send, Shift+Enter for newline)'
          }
          disabled={thinking}
          rows={2}
          className="w-full resize-none rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-200 outline-none focus:border-blue-500 disabled:opacity-60"
        />
      </div>
    </div>
  );
}
