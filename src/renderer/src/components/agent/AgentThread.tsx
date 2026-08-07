import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  ChevronRight,
  FoldVertical,
  ListChecks,
  Paperclip,
  Square,
  TriangleAlert
} from 'lucide-react';
import type {
  AgentAttachRequest,
  AgentAttachment,
  AgentMentionMatch,
  AgentMessage,
  AgentPermissionAsk,
  AgentPermissionOutcome
} from '../../../../shared/agent-types';
import { ATTACHMENT_ACCEPT, messageAttachments, messageText } from '../../../../shared/agent-types';
import { isTodoTool } from '../../../../shared/agent-tools';
import { renderTodoList, type AgentTodoItem } from '../../../../shared/agent-todos';
import { canCompact } from '../../../../shared/agent-context';
import { todoProgress, type TodoProgress } from './todo-view';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentActivity } from './AgentActivity';
import { AgentToolRow } from './AgentToolRow';
import { AgentPermissionRow } from './AgentPermissionRow';
import { AgentAttachmentChip, AgentMessageAttachments } from './AgentAttachment';
import { reasoningLabel } from './activity';
import { AgentContextMeter } from './AgentContextMeter';
import { AgentSpendMeter } from './AgentSpendMeter';
import { AgentLocation } from './AgentLocation';
import { useGitHead } from './use-git-head';
import { usePromptHistory } from './use-prompt-history';
import type { HistoryDirection } from '../../../../shared/agent-history';
import { atFirstRow, atLastRow } from '../../lib/caret-row';
import { EMPTY_SESSION_SPEND, hasSpend } from '../../../../shared/agent-spend';
import { agentSlashCommand, agentSlashMenu, type AgentSlashCommand } from './composer-slash';
import { agentMentionQuery, withoutMentionQuery } from './composer-mention';
import { useComposerMenu, type ComposerMenuAnchor } from './composer-menu';
import { ComposerMenu } from './ComposerMenu';
import { downscaleImage } from '../../lib/downscale-image';
import { useAgentStore } from '../../store/agent-store';
import { useSettingsStore } from '../../store/settings-store';

/**
 * The agent's transcript and composer. One streamed turn at a time, which may
 * read its way around the folder before it answers.
 */
/** Stable empty map, so a pane with no thread does not remount the transcript. */
const EMPTY_PARTIALS: Record<string, string> = {};

/** The same, for a pane whose thread has no task list. */
const EMPTY_TODOS: AgentTodoItem[] = [];

/** How near the end still counts as being at it, in pixels. */
const TAIL_SLACK_PX = 24;

export function AgentThread({
  paneId,
  cwd,
  todosInPanel
}: {
  paneId: string;
  cwd: string;
  /**
   * Whether the pane is showing the task list in its own column. When it is
   * not, the list still has to be somewhere, and the status line is where the
   * pane already says what is happening.
   */
  todosInPanel: boolean;
}): React.JSX.Element {
  const thread = useAgentStore((s) => s.threads[paneId]);
  const send = useAgentStore((s) => s.send);
  const cancel = useAgentStore((s) => s.cancel);
  const compact = useAgentStore((s) => s.compact);
  const startNewSession = useAgentStore((s) => s.startNewSession);
  const catalog = useAgentStore((s) => s.catalog);
  const agent = useSettingsStore((s) => s.settings?.ai.agent ?? null);
  const model = agent?.coding.model ?? null;
  const modelCard = catalog?.models.find((m) => m.id === model) ?? null;

  const decidePermission = useAgentStore((s) => s.decidePermission);

  const messages = thread?.messages ?? [];
  const compacting = (thread?.pendingCompact ?? null) !== null;
  const streaming = (thread?.streamId ?? null) !== null;
  const contextTokens = thread?.contextTokens ?? null;
  const spend = thread?.spend ?? EMPTY_SESSION_SPEND;
  const ask = thread?.pendingPermission ?? null;
  const imagePartials = thread?.imagePartials ?? EMPTY_PARTIALS;
  // Only when the pane has no column for it, so the same list is never in two
  // places saying the same thing.
  const todoItems = thread?.todos ?? EMPTY_TODOS;
  const todos = todosInPanel ? null : todoProgress(todoItems);
  const gitHead = useGitHead(paneId, cwd);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {messages.length === 0 ? (
        <EmptyState />
      ) : (
        <Transcript
          messages={messages}
          streaming={streaming && !compacting}
          ask={ask}
          onDecide={(outcome) => decidePermission(paneId, outcome)}
          imagePartials={imagePartials}
        />
      )}

      {thread?.error != null && (
        <div className="mx-auto flex w-full max-w-2xl items-start gap-2 px-4 pb-2 text-xs text-amber-700 dark:text-amber-400/90">
          <TriangleAlert size={13} className="mt-px shrink-0" />
          <span>{thread.error}</span>
        </div>
      )}

      {/* One status line for the turn: what the agent is doing on the left, how
          much room it has left on the right. Always rendered while either has
          something to say, so neither appearing shoves the composer down. */}
      {(streaming || contextTokens !== null || todos !== null || hasSpend(spend)) && (
        <div className="mx-auto flex w-full max-w-2xl items-center gap-3 px-4 pb-1.5 text-[11px] text-fleet-text-subtle">
          {streaming && (
            <AgentActivity
              last={messages.at(-1)}
              compacting={compacting}
              asking={ask !== null}
              startedAt={thread?.startedAt ?? null}
            />
          )}
          {todos !== null && <TodoChip progress={todos} items={todoItems} />}
          {/* Money first, then room left: what a turn cost is the fact that
              changes with every turn, and the window is the one that only
              matters near its end. */}
          <span className="ml-auto">
            <AgentSpendMeter
              spend={spend}
              model={thread?.served?.model ?? null}
              provider={thread?.served?.provider ?? null}
            />
          </span>
          {contextTokens !== null && (
            <span>
              <AgentContextMeter
                used={contextTokens}
                limit={modelCard?.contextLimit ?? null}
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
        asking={ask !== null}
        cwd={cwd}
        // The conversation is what an attachment belongs to, so it is what the
        // folder holding it is named after and what deleting the session
        // removes. A pane old enough to have no session of its own falls back
        // to its own id, which is a uuid too and just as stable.
        threadId={thread?.sessionId ?? paneId}
        // Not a reason to refuse the attachment - the user can change model and
        // ask again, and the picture is still what they meant to send.
        blind={modelCard !== null && !modelCard.inputImage}
        onSend={(text, attachments) => send(paneId, cwd, text, attachments)}
        onStop={() => cancel(paneId)}
        onClear={() => startNewSession(paneId, cwd)}
      />

      <AgentLocation cwd={cwd} head={gitHead} />
    </div>
  );
}

/**
 * No folder here: the location line under the composer names it, and does so
 * for the whole life of the pane rather than only until the first message.
 */
function EmptyState(): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
      <span className="text-sm font-medium uppercase tracking-[0.3em] text-fleet-text-subtle">
        Agent
      </span>
    </div>
  );
}

function Transcript({
  messages,
  streaming,
  ask,
  onDecide,
  imagePartials
}: {
  messages: AgentMessage[];
  streaming: boolean;
  ask: AgentPermissionAsk | null;
  onDecide: (outcome: AgentPermissionOutcome) => void;
  imagePartials: Record<string, string>;
}): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the reader is parked at the tail. Written only from actual scrolls,
  // so when the content grows it still says where they were before it did.
  const atTail = useRef(true);
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
  //
  // Only for a reader who was already at the tail, though. Growth is not always
  // the reply arriving: opening a tool call grows the transcript too, and
  // someone who scrolled up to open one is asking to look there, not to be
  // taken to the end.
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
      if (!atTail.current) return;
      endRef.current?.scrollIntoView({ block: 'end' });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={() => {
        const el = scrollRef.current;
        if (el === null) return;
        // A line's worth of slack, so "as far down as it goes" survives the
        // fractional scroll heights a zoomed or half-pixel layout produces.
        atTail.current = el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_SLACK_PX;
      }}
    >
      <div ref={contentRef} className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-5">
        {messages.map((message, i) => (
          <Message
            key={message.id}
            message={message}
            streaming={streaming && i === messages.length - 1}
            ask={ask}
            onDecide={onDecide}
            imagePartials={imagePartials}
          />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

/**
 * The task list, when the pane is too narrow to give it a column.
 *
 * A count and the item being worked on, and nothing else. What survives the
 * collapse is the answer to "is it still on the rails" - how far through, and
 * what it is doing now - because that is what someone glances at the panel for.
 * The items themselves do not survive it, and should not: eight of them in a
 * line above the composer is a paragraph, not a glance.
 */
function TodoChip({
  progress,
  items
}: {
  progress: TodoProgress;
  items: AgentTodoItem[];
}): React.JSX.Element {
  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      // What the collapse costs is the plan itself - in this layout there is no
      // width at which the items are readable. A hover title is the whole of
      // the fix: no popover, no state, and the text is the one the model reads.
      title={renderTodoList(items)}
      // The list itself is not on screen in this layout, so the count and the
      // running item are all a screen reader has to go on too.
      aria-label={`Tasks: ${progress.count} done${progress.doing === null ? '' : `, ${progress.doing}`}`}
    >
      {/* A finished list rests here after every job, and `3/3` under a
          to-do icon reads as a list still waiting to be done. */}
      {progress.open ? (
        <ListChecks size={12} className="shrink-0" />
      ) : (
        <Check size={12} className="shrink-0 text-emerald-400/90" />
      )}
      <span className="font-mono tabular-nums">{progress.count}</span>
      {progress.doing !== null && <span className="truncate">{progress.doing}</span>}
    </span>
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
  onDecide,
  imagePartials
}: {
  message: AgentMessage;
  streaming: boolean;
  ask: AgentPermissionAsk | null;
  onDecide: (outcome: AgentPermissionOutcome) => void;
  /** Half-drawn renders for the image calls still running, by call id. */
  imagePartials: Record<string, string>;
}): React.JSX.Element {
  if (message.role === 'summary') return <SummaryCard summary={messageText(message)} />;
  if (message.role === 'user') {
    const text = messageText(message);
    return (
      // Attachments above the words, the way they sat above the box they were
      // typed in. A message that is only an attachment has no bubble at all -
      // an empty one would be a thing the user did not say.
      <div className="flex flex-col items-end gap-1.5">
        <AgentMessageAttachments attachments={messageAttachments(message)} />
        {text !== '' && (
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-fleet-glass-surface-2 px-3.5 py-2 text-sm text-fleet-text backdrop-blur-md">
            {text}
          </div>
        )}
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
      {message.parts.map((part, i) => {
        // Attachments are the user's, so an assistant turn never holds one.
        if (part.type === 'attachment') return null;
        // The task list is already on screen, either in its column or on the
        // status line. A row here as well would report every tick twice, and
        // fill a long turn's transcript with bookkeeping.
        if (part.type === 'tool' && isTodoTool(part.call.name)) return null;
        if (part.type === 'text') {
          return (
            <div key={i} className="text-fleet-text">
              <AgentMarkdown streaming={streaming && i === lastPart}>{part.text}</AgentMarkdown>
            </div>
          );
        }
        // The question takes the row's place: until it is answered there is
        // nothing else that row could be saying.
        return ask?.callId === part.call.id ? (
          <AgentPermissionRow key={i} ask={ask} onDecide={onDecide} />
        ) : (
          <AgentToolRow key={i} call={part.call} partial={imagePartials[part.call.id]} />
        );
      })}
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

/** How long to wait for the typing to settle before searching the folder. */
const MENTION_DEBOUNCE_MS = 120;

/**
 * A line above the composer about something worth knowing and not worth
 * stopping for - a file that could not be attached, a model that will not look
 * at the picture. Announced rather than shown, since it appears while the user
 * is typing and their eyes are in the box.
 */
function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p
      role="status"
      className="flex items-start gap-1.5 px-1 pb-1.5 text-[11px] text-amber-700 dark:text-amber-400/90"
    >
      <TriangleAlert size={12} className="mt-px shrink-0" />
      {children}
    </p>
  );
}

function Composer({
  disabled,
  streaming,
  asking,
  cwd,
  threadId,
  blind,
  onSend,
  onStop,
  onClear
}: {
  disabled: boolean;
  streaming: boolean;
  /** Stopped on a question, which is the one thing typing here cannot answer. */
  asking: boolean;
  cwd: string;
  /** What an attachment is filed under, and deleted with. */
  threadId: string;
  /** The chosen model cannot see pictures. Worth saying; not worth refusing. */
  blind: boolean;
  onSend: (text: string, attachments: AgentAttachment[]) => void;
  onStop: () => void;
  onClear: () => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [refused, setRefused] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mentions, setMentions] = useState<AgentMentionMatch[]>([]);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const history = usePromptHistory(cwd);

  const slashMenu = agentSlashMenu(text, menuDismissed);
  const mentionQuery = agentMentionQuery(text, mentionDismissed);

  /**
   * Hand one thing to main and keep what comes back.
   *
   * Refusals arrive as results rather than as failures, because a file that is
   * too large or of a kind Fleet cannot read is an ordinary thing to try - it
   * wants a line under the composer, not a thrown error.
   */
  const attach = useCallback(
    async (source: AgentAttachRequest['source']): Promise<void> => {
      const result = await window.fleet.agent.attach({ threadId, cwd, source });
      if (!result.ok) {
        setAttachError(result.error);
        return;
      }
      setAttachError(null);
      setAttachments((current) => [...current, result.attachment]);
    },
    [cwd, threadId]
  );

  /** Files from a paste, a drop or the picker - all the same thing from here. */
  const attachFiles = useCallback(
    async (files: File[]): Promise<void> => {
      for (const file of files) {
        // A picture is shrunk on the way in; anything else goes as it is.
        const { bytes, mimeType } = file.type.startsWith('image/')
          ? await downscaleImage(file)
          : { bytes: await file.arrayBuffer(), mimeType: file.type };
        await attach({ kind: 'bytes', name: file.name, mimeType, bytes });
      }
    },
    [attach]
  );

  // What the `@` menu is offering. Debounced, because it walks the folder, and
  // sequence-guarded, because a slow search for `a` must not land on top of a
  // finished one for `agent`.
  const search = useRef(0);
  useEffect(() => {
    // Bumped before the early return too, so a search still in flight when the
    // menu closes cannot land afterwards and leave the next `@` showing the
    // previous query's files.
    const ticket = ++search.current;
    if (mentionQuery === null) {
      setMentions([]);
      return;
    }
    const timer = setTimeout(() => {
      void window.fleet.agent.mentionSearch(mentionQuery, cwd).then((matches) => {
        if (search.current === ticket) setMentions(matches);
      });
    }, MENTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mentionQuery, cwd]);

  // Grow with the content up to the max height the class caps it at.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Where a recalled prompt should leave the caret, applied once React has put
  // the text in the box. At the end of it, as every shell does: the point of
  // getting an old prompt back is usually to add to it or send it again.
  const caretTo = useRef<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    const at = caretTo.current;
    if (el === null || at === null) return;
    caretTo.current = null;
    el.setSelectionRange(at, at);
    // A long recalled prompt is taller than the box, and the end of it is what
    // was just asked for.
    el.scrollTop = el.scrollHeight;
  }, [text]);

  // The turn is over, so the message that could not go while it ran can go
  // now, and saying otherwise would be stale.
  useEffect(() => {
    if (!streaming) setRefused(false);
  }, [streaming]);

  /**
   * Start a new session. Refused mid-turn exactly the way a message is: the
   * conversation being replaced is the one still being written.
   */
  const runClear = (): void => {
    setMenuDismissed(true);
    if (streaming) {
      setRefused(true);
      return;
    }
    onClear();
    setText('');
    // The chips go too. They were filed under the session being left behind,
    // and deleting that session would delete the files out from under them.
    setAttachments([]);
    setAttachError(null);
  };

  /**
   * Run a command, from wherever it was picked. The one place that knows what
   * a command name means, so the menu and the typed line cannot drift apart.
   */
  const runCommand = (command: AgentSlashCommand): void => {
    switch (command.name) {
      case 'clear':
        runClear();
        return;
    }
  };

  /** Take a file out of the pending row. It was never sent, so nothing else changes. */
  const removeAttachment = (at: number): void => {
    setAttachments((current) => current.filter((_, i) => i !== at));
    setAttachError(null);
  };

  // The same widget over the same box, differing only in where the rows come
  // from and what taking one does. Picking a command runs it rather than
  // filling the box: the command is the whole of what the user meant.
  const commandMenu = useComposerMenu({
    items: slashMenu.open ? slashMenu.matches : [],
    onPick: runCommand,
    onDismiss: () => setMenuDismissed(true)
  });

  /** Turn the `@…` being typed into an attachment, and take it out of the line. */
  const mentionMenu = useComposerMenu({
    items: mentionQuery === null ? [] : mentions,
    onPick: (match: AgentMentionMatch) => {
      setText(withoutMentionQuery(text));
      void attach({ kind: 'path', path: match.path });
      ref.current?.focus();
    },
    onDismiss: () => setMentionDismissed(true)
  });

  /** Whichever one is up, for the composer's own combobox wiring. */
  const openMenu: ComposerMenuAnchor | null = mentionMenu.open
    ? mentionMenu
    : commandMenu.open
      ? commandMenu
      : null;

  /**
   * Up and Down, once the `/` and `@` menus have had their turn with them.
   *
   * Only at the near edge of the box: while the prompt still has rows above the
   * caret, Up belongs to the caret. Rows here means what is on screen, so a
   * paragraph that has wrapped counts even with no newline in it - the whole
   * point is that a long draft cannot be swapped out from under someone who was
   * only trying to get back to the top of it.
   *
   * Attachments are left alone. A recalled prompt is text, and the pictures
   * clipped to the message being written are still the ones being sent.
   */
  const recall = (e: React.KeyboardEvent, direction: HistoryDirection): boolean => {
    const el = ref.current;
    if (el === null) return false;
    if (!(direction === 'back' ? atFirstRow(el) : atLastRow(el))) return false;
    const next = history.step(direction, text);
    // Nowhere further to go: leave the key alone rather than swallow it, so it
    // still does whatever it would have done.
    if (next === null) return false;
    e.preventDefault();
    setText(next);
    caretTo.current = next.length;
    return true;
  };

  const submit = (): void => {
    const trimmed = text.trim();
    // An attachment on its own is a message: "look at this" is what dropping a
    // screenshot into a composer means.
    if ((trimmed === '' && attachments.length === 0) || disabled) return;
    // A command is what it does, not something to say to the model.
    const typed = agentSlashCommand(trimmed);
    if (typed !== undefined) {
      runCommand(typed);
      return;
    }
    // Not sent, and not thrown away either: the draft stays exactly where it
    // was typed. Silently doing nothing is what makes this feel like a message
    // that vanished, so it is worth a line saying what happened.
    if (streaming) {
      setRefused(true);
      return;
    }
    onSend(trimmed, attachments);
    history.remember(trimmed);
    setText('');
    setAttachments([]);
    setAttachError(null);
  };

  const hasImage = attachments.some((a) => a.kind === 'image');

  return (
    <div
      // Bottom padding is the location line's, below - the composer only needs
      // the gap between itself and it.
      className="mx-auto w-full max-w-2xl shrink-0 px-4 pb-1.5"
      // On the whole composer rather than on the textarea: aiming a dragged
      // file at a one-line box is a game, and the target should be the thing
      // that looks like the target.
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only when the pointer has actually left the composer - moving over a
        // child fires this too, and would make the highlight flicker.
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files];
        if (files.length === 0) return;
        e.preventDefault();
        setDragging(false);
        void attachFiles(files);
      }}
    >
      {refused && (
        <p role="status" className="px-1 pb-1.5 text-[11px] text-fleet-text-subtle">
          {asking
            ? 'Answer the question above first - your message is still here.'
            : 'The agent is still working - your message is still here.'}
        </p>
      )}
      {attachError !== null && <Notice>{attachError}</Notice>}
      {blind && hasImage && (
        <Notice>
          This model cannot see images. It will be sent, but the model may ignore it - choose one
          with vision in Settings to have it looked at.
        </Notice>
      )}
      <div
        className={`relative flex flex-col gap-2 rounded-xl border bg-fleet-glass-surface p-2 backdrop-blur-md ${
          dragging
            ? 'border-fleet-accent'
            : 'border-fleet-border focus-within:border-fleet-border-strong'
        }`}
      >
        <ComposerMenu menu={mentionMenu} label="Files" itemKey={(match) => match.path}>
          {(match) => (
            <span className="truncate font-mono text-xs text-fleet-text">{match.rel}</span>
          )}
        </ComposerMenu>
        <ComposerMenu menu={commandMenu} label="Commands" itemKey={(command) => command.name}>
          {(command) => (
            <>
              <command.Icon size={12} className="shrink-0 text-fleet-text-muted" />
              <span className="font-mono text-xs text-fleet-text">/{command.name}</span>
              <span className="ml-1 line-clamp-1 text-[11px] text-fleet-text-muted">
                {command.description}
              </span>
            </>
          )}
        </ComposerMenu>
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2.5 px-0.5 pt-1">
            {attachments.map((attachment, i) => (
              <AgentAttachmentChip
                key={i}
                attachment={attachment}
                onRemove={() => removeAttachment(i)}
              />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              // Cleared so picking the same file twice in a row still fires.
              e.target.value = '';
              void attachFiles(files);
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            aria-label="Attach a file"
            title="Attach an image or a PDF"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-fleet-text-muted transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text disabled:cursor-not-allowed disabled:opacity-40 focus-ring"
          >
            <Paperclip size={14} />
          </button>
          <textarea
            ref={ref}
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(e) => {
              setText(e.target.value);
              // Typing again is a fresh attempt, so a menu dismissed with Escape
              // is allowed back, at the top of its list.
              setMenuDismissed(false);
              setMentionDismissed(false);
              commandMenu.reset();
              mentionMenu.reset();
              // Editing ends the walk through history: what is in the box is
              // yours again, and the next Up sets it aside as the draft rather
              // than treating it as the old prompt it started life as.
              history.reset();
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length === 0) return;
              // Only when there are files: a paste that is both an image and its
              // own text - copying out of a design tool - should still put the
              // text in the box.
              if (e.clipboardData.getData('text/plain') === '') e.preventDefault();
              void attachFiles(files);
            }}
            onKeyDown={(e) => {
              if (mentionMenu.keyDown(e) || commandMenu.keyDown(e)) return;
              // Bare arrows only. Cmd and Alt make these jump to the ends of the
              // text, and Shift makes them select - all three are the caret's,
              // and none of them is a request for an older prompt.
              if (
                (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
                !e.shiftKey &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.altKey
              ) {
                if (recall(e, e.key === 'ArrowUp' ? 'back' : 'forward')) return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            // The turn is not listening here until the question above is
            // answered, and Enter doing nothing at all reads as a dropped
            // message. The draft is left alone - it is still worth sending after.
            placeholder={
              disabled
                ? 'Choose a coding model in Settings first'
                : asking
                  ? 'Answer the question above to carry on'
                  : 'Ask the agent…'
            }
            aria-label="Message the agent"
            // The composer *is* the combobox while a menu is up: it keeps focus,
            // and points at the row the next Enter would take.
            role="combobox"
            aria-expanded={openMenu !== null}
            aria-controls={openMenu?.id}
            aria-activedescendant={
              openMenu === null ? undefined : `${openMenu.id}-${openMenu.active}`
            }
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
              disabled={(text.trim() === '' && attachments.length === 0) || disabled}
              aria-label="Send"
              title="Send"
              className="flex size-7 shrink-0 items-center justify-center rounded-lg fleet-accent-bg text-white transition-opacity disabled:opacity-30 focus-ring-offset"
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
