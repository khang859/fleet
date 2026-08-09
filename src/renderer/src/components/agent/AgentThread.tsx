import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  Clock,
  FoldVertical,
  ListChecks,
  Paperclip,
  Square,
  TriangleAlert,
  X
} from 'lucide-react';
import type {
  AgentAttachRequest,
  AgentAttachment,
  AgentMentionMatch,
  AgentMessage,
  AgentPermissionAsk,
  AgentPermissionOutcome,
  AgentToolMode
} from '../../../../shared/agent-types';
import {
  ATTACHMENT_ACCEPT,
  DEFAULT_AGENT_SETTINGS,
  messageAttachments,
  messageText
} from '../../../../shared/agent-types';
import { isTodoTool } from '../../../../shared/agent-tools';
import { renderTodoList, type AgentTodoItem } from '../../../../shared/agent-todos';
import { canCompact, clearedCallIds } from '../../../../shared/agent-context';
import { todoProgress, type TodoProgress } from './todo-view';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentActivity } from './AgentActivity';
import { AgentToolRow } from './AgentToolRow';
import { AgentToolGroup } from './AgentToolGroup';
import { groupParts } from './tool-group';
import { AgentPermissionRow } from './AgentPermissionRow';
import { AgentTaskCard } from './AgentTaskCard';
import { AgentScheduleFire } from './AgentScheduleFire';
import { AgentTaskPermissions } from './AgentTaskPermissions';
import { pendingTaskAsks, type PendingTaskAsk } from './task-permissions';
import type { RunningSubagent } from './subagent-view';
import { scheduleChip, type ScheduleRow } from './schedule-view';
import { cancelSchedule } from '../../store/agent-schedule';
import { ToolModePicker } from './ToolModePicker';
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
import {
  agentSlashCommand,
  agentSlashMenu,
  isSlashQuery,
  type AgentSlashCommand
} from './composer-slash';
import { useAgentCommands } from './use-agent-commands';
import { agentMentionQuery, withoutMentionQuery } from './composer-mention';
import { useComposerMenu, type ComposerMenuAnchor } from './composer-menu';
import { INTERRUPT_ARM_MS, composerIntent, settleDelay } from './composer-keys';
import { useVoiceDictation } from './use-voice-dictation';
import { VoiceButton } from './VoiceButton';
import { VOICE_COUNTDOWN_MS, VOICE_MAX_MS } from '../../../../shared/agent-voice';
import { atTail, lostRoom } from './transcript-tail';
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

/** The same, for a pane with no thread yet. */
const EMPTY_MESSAGES: AgentMessage[] = [];

/** The same, for a pane with no subagents running. */
const EMPTY_TASK_ACTIVITY: Record<string, string | null> = {};

/** The same, for a pane with no subagent waiting on a command. */
const EMPTY_TASK_PERMISSIONS: Record<string, AgentPermissionAsk> = {};

/** Stable empty release list, so clearing one twice does not re-render. */
const NOTHING_RELEASED: readonly string[] = [];

/**
 * The pending questions, each held back until the composer goes quiet.
 *
 * Returns the pane's own question and the subagents' - each only once it is safe
 * to draw - plus the callback the composer uses to say the message being written
 * has just changed. That is reported through a ref rather than state so the
 * common case - writing with nothing pending - costs no render at all; the timer
 * re-reads that ref when it fires and puts itself back if the user is still
 * going.
 *
 * A subagent's question cannot take a keystroke the way the pane's own can:
 * nothing moves focus, and Enter never answers one. But the strip it appears in
 * grows out of the top of the composer and pushes it down the pane, which is
 * enough to slide a button under a mouse already on its way to the box. Same
 * hold, same clock - what the user is in the middle of doing is what decides
 * when any of them appear.
 *
 * What has been let through is remembered by request id, so that answering one
 * of several does not hold the rest back a second time, and a subagent's next
 * question waits on its own account rather than arriving on the last one's
 * ticket.
 */
function useSettledAsks(
  ask: AgentPermissionAsk | null,
  tasks: PendingTaskAsk[]
): {
  settled: AgentPermissionAsk | null;
  settledTasks: PendingTaskAsk[];
  noteDraft: () => void;
} {
  const [released, setReleased] = useState(NOTHING_RELEASED);
  const draftedAt = useRef(0);
  const waiting = useRef(NOTHING_RELEASED);

  const pending = [
    ...(ask === null ? [] : [ask.requestId]),
    ...tasks.map((task) => task.ask.requestId)
  ];
  // Keyed on which questions are waiting rather than how many, since one
  // arriving as another is answered leaves the count where it was.
  const key = pending.join(' ');

  // Declared first so it has already run by the time the timer below is
  // scheduled: what gets released is whatever is waiting when the composer goes
  // quiet, not whatever was waiting when the wait began.
  useEffect(() => {
    waiting.current = pending;
  });

  useEffect(() => {
    if (key === '') {
      // Nothing is waiting, so nothing is owed a release. Kept tidy rather than
      // left to accumulate - ids are uuids and never come round again, so this
      // is housekeeping and not part of the guard.
      setReleased(NOTHING_RELEASED);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const settle = (): void => {
      const wait = settleDelay(Date.now(), draftedAt.current);
      if (wait === 0) {
        setReleased(waiting.current);
        return;
      }
      timer = setTimeout(settle, wait);
    };
    timer = setTimeout(settle, 0);
    return () => clearTimeout(timer);
  }, [key]);

  const noteDraft = useCallback(() => {
    draftedAt.current = Date.now();
  }, []);

  // Filtered against what is still waiting, so a question that has been answered
  // leaves the screen the moment it is - the hold is on the way in only.
  return {
    settled: ask !== null && released.includes(ask.requestId) ? ask : null,
    settledTasks: tasks.filter((task) => released.includes(task.ask.requestId)),
    noteDraft
  };
}

export function AgentThread({
  paneId,
  cwd,
  todosInPanel,
  running,
  subagentsInPanel,
  schedules,
  schedulesInPanel
}: {
  paneId: string;
  cwd: string;
  /**
   * Whether the pane is showing the task list in its own column. When it is
   * not, the list still has to be somewhere, and the status line is where the
   * pane already says what is happening.
   */
  todosInPanel: boolean;
  /**
   * The subagents still out there. Handed down rather than worked out here,
   * because the pane needs the same list to decide whether to give it a column
   * and deriving it twice would walk the transcript twice on every frame.
   */
  running: RunningSubagent[];
  /** The same as `todosInPanel`, for the subagents. */
  subagentsInPanel: boolean;
  /** What this conversation has set to wake itself up with, in display order. */
  schedules: ScheduleRow[];
  /** The same as `todosInPanel`, for the schedules. */
  schedulesInPanel: boolean;
}): React.JSX.Element {
  const thread = useAgentStore((s) => s.threads[paneId]);
  const send = useAgentStore((s) => s.send);
  const cancel = useAgentStore((s) => s.cancel);
  const compact = useAgentStore((s) => s.compact);
  const startNewSession = useAgentStore((s) => s.startNewSession);
  const catalog = useAgentStore((s) => s.catalog);
  const agent = useSettingsStore((s) => s.settings?.ai.agent ?? null);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const model = agent?.coding.model ?? null;
  const modelCard = catalog?.models.find((m) => m.id === model) ?? null;

  const decidePermission = useAgentStore((s) => s.decidePermission);
  const decideTaskPermission = useAgentStore((s) => s.decideTaskPermission);

  // The shared empty rather than a fresh `[]`: two memos below key on this, and
  // a new array every render would mean neither ever hits for a pane whose
  // thread has not loaded yet.
  const messages = thread?.messages ?? EMPTY_MESSAGES;
  const compacting = (thread?.pendingCompact ?? null) !== null;
  const streaming = (thread?.streamId ?? null) !== null;
  const contextTokens = thread?.contextTokens ?? null;
  const spend = thread?.spend ?? EMPTY_SESSION_SPEND;
  const imagePartials = thread?.imagePartials ?? EMPTY_PARTIALS;
  const taskActivity = thread?.taskActivity ?? EMPTY_TASK_ACTIVITY;
  const taskPermissions = thread?.taskPermissions ?? EMPTY_TASK_PERMISSIONS;
  // Held apart from the render below it because it walks the transcript, and
  // this component re-renders on every token of a streaming turn - the same
  // reason `cleared` is memoized further down.
  const asks = useMemo(
    () => pendingTaskAsks(messages, taskPermissions),
    [messages, taskPermissions]
  );
  // Everything downstream asks "is there a question on screen", which is not
  // quite "has one been asked" - so the held-back ones are what they are given.
  const {
    settled: ask,
    settledTasks: pendingTasks,
    noteDraft
  } = useSettledAsks(thread?.pendingPermission ?? null, asks);
  // Only when the pane has no column for it, so the same list is never in two
  // places saying the same thing.
  const todoItems = thread?.todos ?? EMPTY_TODOS;
  const todos = todosInPanel ? null : todoProgress(todoItems);
  const subagents = subagentsInPanel || running.length === 0 ? null : running;
  const scheduleChips = schedulesInPanel || schedules.length === 0 ? null : schedules;
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
          onDecide={(outcome, requestId) => decidePermission(paneId, outcome, requestId)}
          imagePartials={imagePartials}
          taskActivity={taskActivity}
          taskPermissions={taskPermissions}
        />
      )}

      {/* Everything that does not scroll, held together so it can be given the
          room the transcript's scrollbar takes out of the transcript. Reading
          down the pane, the composer's edges are the ones a message is measured
          against, and they line up only if both are told the same number. */}
      <div className="fleet-scroll-inset flex shrink-0 flex-col">
        {thread?.error != null && (
          <div className="mx-auto flex w-full max-w-2xl items-start gap-2 px-4 pb-2 text-xs text-amber-700 dark:text-amber-400/90">
            <TriangleAlert size={13} className="mt-px shrink-0" />
            <span>{thread.error}</span>
          </div>
        )}

        {/* Above the status line rather than below it, so the strip sits against
            the transcript it came out of and the status line stays where it has
            always been: the row directly over the composer. */}
        <AgentTaskPermissions pending={pendingTasks} onDecide={decideTaskPermission} />

        {/* One status line for the turn: what the agent is doing on the left, how
            much room it has left on the right. Always rendered while either has
            something to say, so neither appearing shoves the composer down. */}
        {(streaming ||
          contextTokens !== null ||
          todos !== null ||
          subagents !== null ||
          hasSpend(spend)) && (
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
            {subagents !== null && <SubagentChip running={subagents} />}
            {scheduleChips !== null && <ScheduleChip rows={scheduleChips} />}
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
          // The card on screen, not whatever the store is holding now: a question
          // that arrived after this one was drawn has not been read yet, and a key
          // pressed at the old one must not answer the new one.
          onApprove={() => {
            if (ask !== null) decidePermission(paneId, 'once', ask.requestId);
          }}
          onDraft={noteDraft}
          toolMode={agent?.toolMode ?? DEFAULT_AGENT_SETTINGS.toolMode}
          onToolMode={(toolMode) => void updateSettings({ ai: { agent: { toolMode } } })}
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
          branch={gitHead?.branch ?? null}
        />

        <AgentLocation cwd={cwd} head={gitHead} />
      </div>
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
  imagePartials,
  taskActivity,
  taskPermissions
}: {
  messages: AgentMessage[];
  streaming: boolean;
  ask: AgentPermissionAsk | null;
  onDecide: (outcome: AgentPermissionOutcome, requestId: string) => void;
  imagePartials: Record<string, string>;
  taskActivity: Record<string, string | null>;
  taskPermissions: Record<string, AgentPermissionAsk>;
}): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the reader is parked at the tail. Written only from actual scrolls,
  // so when the content grows it still says where they were before it did.
  const parked = useRef(true);
  const last = messages.at(-1);
  // Which results the next request will leave out. Worked out from the same
  // transcript and by the same function main uses, so a row that says it was
  // cleared is one the model is genuinely no longer being told about.
  const cleared = useMemo(() => clearedCallIds(messages), [messages]);

  // Follow the stream. Keyed on the growing text so every delta scrolls.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, last?.parts, last?.reasoning]);

  // A reply keeps growing after React has finished with it, and the window onto
  // it can shrink under a line that was not there before - `lostRoom` is what
  // those two have in common. Watching the elements themselves rather than the
  // render that changed them is what catches the asynchronous half: a code
  // block highlighted after the fact lands taller than the space held for it.
  //
  // Only for a reader who was already at the tail, though. Growth is not always
  // the reply arriving: opening a tool call grows the transcript too, and
  // someone who scrolled up to open one is asking to look there, not to be
  // taken to the end.
  useEffect(() => {
    const content = contentRef.current;
    const port = scrollRef.current;
    if (content === null || port === null) return;

    let room = { content: content.getBoundingClientRect().height, port: port.clientHeight };
    const observer = new ResizeObserver(() => {
      const now = { content: content.getBoundingClientRect().height, port: port.clientHeight };
      const lost = lostRoom(room, now);
      room = now;
      // Read after the sizes are recorded, so a move the reader made is not
      // remembered as one they did not.
      if (!lost || !parked.current) return;
      endRef.current?.scrollIntoView({ block: 'end' });
    });
    observer.observe(content);
    observer.observe(port);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={scrollRef}
      // `fleet-scroll-balanced` so the transcript reads down the same column the
      // composer sits in rather than half a scrollbar to the left of it; the
      // rows under it carry the matching `fleet-scroll-inset`.
      className="fleet-scroll-balanced min-h-0 flex-1 overflow-y-auto"
      onScroll={() => {
        const el = scrollRef.current;
        if (el === null) return;
        parked.current = atTail(el);
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
            cleared={cleared}
            taskActivity={taskActivity}
            taskPermissions={taskPermissions}
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
 * The subagents, when the pane is too narrow to give them a column.
 *
 * How many are out there, and - when there is only one - what it is doing. With
 * two or more there is no honest one-line answer: they are working on different
 * things at once, and picking one of them to name would read as the only thing
 * happening. The count is what survives, since the reason to glance at this at
 * all is that work is going on somewhere other than the transcript.
 *
 * The one exception is a child stopped on a command, which is said however many
 * there are: it is not working, it is waiting, and the strip that can answer it
 * is directly below this line.
 */
function SubagentChip({ running }: { running: RunningSubagent[] }): React.JSX.Element {
  const asking = running.filter((subagent) => subagent.asking).length;
  const only = running.length === 1 ? running[0] : null;
  const label =
    asking > 0
      ? `${asking} waiting on you`
      : only !== null
        ? (only.activity ?? 'starting')
        : `${running.length} subagents`;

  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      // What the collapse costs is which subagent is on what. A hover title is
      // the whole of the fix, the same one the task list's chip makes.
      title={running.map((subagent) => `${subagent.agent}: ${subagent.prompt}`).join('\n')}
      aria-label={`Subagents: ${running.length} running${asking > 0 ? `, ${asking} waiting on you` : ''}`}
    >
      <Bot size={12} className="shrink-0" />
      <span className="font-mono tabular-nums">{running.length}</span>
      <span className={`truncate ${asking > 0 ? 'text-amber-700 dark:text-amber-400/90' : ''}`}>
        {label}
      </span>
    </span>
  );
}

/**
 * The check-ins this conversation has set, for a pane with no column to put
 * them in.
 *
 * When rather than what, because when is the fact: what a schedule is about is
 * on the tool call that set it, and the thing the user cannot otherwise know is
 * that this pane is going to start working at nine tomorrow. Absolute rather
 * than a countdown - a ticking clock in the status line is movement nobody
 * asked for.
 */
function ScheduleChip({ rows }: { rows: ScheduleRow[] }): React.JSX.Element {
  const { label, title } = scheduleChip(rows);
  const only = rows.length === 1 ? rows[0] : null;

  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      // What the collapse costs is which check-in is about what, the same thing
      // the subagent chip's title buys back.
      title={title}
      aria-label={`Schedules: ${rows.length} set, next ${label}`}
    >
      <Clock size={12} className="shrink-0" />
      <span className="font-mono tabular-nums">{rows.length}</span>
      <span className="truncate">{label}</span>
      {/* The stop button follows the one thing it could mean. With several set
          the chip says only how many, and an X beside a count is a button
          whose target the user cannot see - so cancelling one of several is
          left to the card, which names each. The pane at this width is one
          drag away from having that card. */}
      {only !== null && (
        <button
          type="button"
          onClick={() => void cancelSchedule(only.id)}
          aria-label={`Cancel the check-in ${only.when}`}
          title="Cancel this check-in"
          className="focus-ring shrink-0 text-fleet-text-subtle transition-colors hover:text-fleet-text"
        >
          <X size={11} />
        </button>
      )}
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
  imagePartials,
  cleared,
  taskActivity,
  taskPermissions
}: {
  message: AgentMessage;
  streaming: boolean;
  ask: AgentPermissionAsk | null;
  onDecide: (outcome: AgentPermissionOutcome, requestId: string) => void;
  /** Half-drawn renders for the image calls still running, by call id. */
  imagePartials: Record<string, string>;
  /** Calls whose result is no longer being sent to the model, by call id. */
  cleared: Set<string>;
  /** What each running subagent is doing right now, by task id. */
  taskActivity: Record<string, string | null>;
  /** The command each stopped subagent is waiting on, by task id. */
  taskPermissions: Record<string, AgentPermissionAsk>;
}): React.JSX.Element {
  if (message.role === 'summary') return <SummaryCard summary={messageText(message)} />;
  // Before the user check, and it has to be: a fire is neither side of the
  // conversation, and drawn as either one it would read as somebody having said
  // something nobody said.
  if (message.role === 'scheduled') return <AgentScheduleFire text={messageText(message)} />;
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
          what it said about what it found, with a run of the same lookup folded
          into one row. Keyed by position because that is what a part is - text
          parts have no id, and two of them are only distinguishable by where
          they fall; a folded run takes the position of the first call in it. */}
      {groupParts(message.parts, ask?.callId ?? null).map((item) => {
        if (item.kind === 'run') {
          return (
            <AgentToolGroup key={item.key} name={item.name} calls={item.calls} cleared={cleared} />
          );
        }
        const { part, key: i } = item;
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
        if (ask?.callId === part.call.id) {
          return <AgentPermissionRow key={i} ask={ask} onDecide={onDecide} />;
        }
        // A subagent is a conversation rather than a call, and gets a card.
        if (part.call.name === 'task' && part.call.task !== null) {
          return (
            <AgentTaskCard
              key={i}
              call={part.call}
              activity={taskActivity[part.call.task.id]}
              asking={part.call.task.id in taskPermissions}
            />
          );
        }
        return (
          <AgentToolRow
            key={i}
            call={part.call}
            partial={imagePartials[part.call.id]}
            cleared={cleared.has(part.call.id)}
          />
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
  onApprove,
  onDraft,
  toolMode,
  onToolMode,
  threadId,
  blind,
  onSend,
  onStop,
  onClear,
  branch
}: {
  disabled: boolean;
  streaming: boolean;
  /** Stopped on a question, which is the one thing typing here cannot answer. */
  asking: boolean;
  cwd: string;
  /** The pane's git branch, fed to the dictation recognition hints. */
  branch: string | null;
  /** Run the command being asked about, once. What Enter means while it is up. */
  onApprove: () => void;
  /**
   * The message being written has just changed, so a question waiting to be
   * asked should keep waiting. Typing is most of it, but a file being attached
   * counts the same: both mean hands on the composer.
   */
  onDraft: () => void;
  /** Who answers the permission questions. App-wide, like every agent setting. */
  toolMode: AgentToolMode;
  onToolMode: (mode: AgentToolMode) => void;
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
  /** Whether an Escape is loaded, waiting on the second one that stops the turn. */
  const [armed, setArmed] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mentions, setMentions] = useState<AgentMentionMatch[]>([]);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const history = usePromptHistory(cwd);

  const commands = useAgentCommands(cwd, isSlashQuery(text) && !menuDismissed);
  const slashMenu = agentSlashMenu(text, commands, menuDismissed);
  const mentionQuery = agentMentionQuery(text, mentionDismissed);

  const hasKey = useAgentStore((s) => s.keyPresent);

  /*
   * Voice dictation. The hook owns the media and the state machine; this
   * component only decides where the words land (at the caret) and how the
   * keys that already mean something here give way to a recording.
   */
  // True once the user sends (or clears) until the next recording starts, so a
  // transcript that returns after the message went out is dropped rather than
  // arriving in the next empty box (plan section 8.3).
  const droppedRef = useRef(false);

  /**
   * The words land at the live caret: `execCommand('insertText')` inserts at
   * where the selection is now (so text typed or a caret moved during the
   * transcription is honoured), replaces a selection the way ordinary typing
   * does, and makes Cmd+Z restore the pre-insert text. The browser mutates the
   * DOM value, which is pulled back into React state afterwards.
   */
  const insertTranscript = useCallback(
    (text: string) => {
      if (droppedRef.current) return;
      const el = ref.current;
      if (el === null) return;
      el.focus();
      document.execCommand('insertText', false, text);
      setText(el.value);
      onDraft();
    },
    [onDraft]
  );

  const voice = useVoiceDictation({ cwd, branch, onTranscript: insertTranscript });

  // A fresh recording is a fresh chance for the previous transcript to land.
  useEffect(() => {
    if (voice.state.phase === 'recording') droppedRef.current = false;
  }, [voice.state.phase]);

  // Whether this recording is the down-half of a hold: the composer's hint says
  // "release to insert" only while a finger is really holding.
  const holding = voice.state.phase === 'recording' && voice.state.gesture !== 'tap';
  const remaining = Math.max(0, VOICE_MAX_MS - voice.elapsed);

  /**
   * Escape's way out: cancel whatever voice is doing, and swallow the key so it
   * does not also arm the interrupt. The dropped flag is set first, so a word
   * already on its way back is declined when it lands.
   */
  const cancelVoice = useCallback(() => {
    droppedRef.current = true;
    voice.cancel();
  }, [voice]);

  /**
   * Cmd+Shift+V toggles recording (plan section 7.3). Deliberately not a hold
   * key: in a textarea a hold collides with typing, which is the bug Claude
   * Code had to patch. One action rather than a down and an up, because a
   * keystroke's two halves share a render and the second would overwrite the
   * first's command before it ever ran.
   */
  const toggleVoice = useCallback(() => {
    voice.toggle();
  }, [voice]);

  /**
   * Hand one thing to main and keep what comes back.
   *
   * Refusals arrive as results rather than as failures, because a file that is
   * too large or of a kind Fleet cannot read is an ordinary thing to try - it
   * wants a line under the composer, not a thrown error.
   */
  const attach = useCallback(
    async (source: AgentAttachRequest['source']): Promise<void> => {
      // Attaching is composing too. Every way in - the picker, a drop, a paste,
      // an `@` picked off the menu - comes through here, so this is the one
      // place a question waiting to be asked has to be told to keep waiting.
      // Twice: main reads the file in between, and a card that landed during
      // that read would land on someone with their hands still on the composer.
      onDraft();
      const result = await window.fleet.agent.attach({ threadId, cwd, source });
      onDraft();
      if (!result.ok) {
        setAttachError(result.error);
        return;
      }
      setAttachError(null);
      setAttachments((current) => [...current, result.attachment]);
    },
    [cwd, threadId, onDraft]
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
  // now, and saying otherwise would be stale. A loaded Escape goes with it:
  // there is no longer a turn for the second press to stop, and one left armed
  // would spend itself on the next turn instead of this one.
  useEffect(() => {
    if (streaming) return;
    setRefused(false);
    setArmed(false);
  }, [streaming]);

  // A first Escape is forgotten if the second never comes. Without this it
  // waits indefinitely, and the press that closed a menu a minute ago is still
  // holding the trigger when the user reaches for Escape again.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), INTERRUPT_ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

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
    // The box is being emptied; a transcript still in flight must not land in
    // the fresh one.
    droppedRef.current = true;
    onClear();
    setText('');
    // The chips go too. They were filed under the session being left behind,
    // and deleting that session would delete the files out from under them.
    setAttachments([]);
    setAttachError(null);
  };

  /**
   * Take a row off the `/` menu.
   *
   * A builtin runs on the spot, because picking `/clear` is the whole of what
   * the user meant. A prompt command is put in the box instead, with the space
   * after it already typed: it was picked in order to say which pull request,
   * or what to look at, and running it the instant it is named would spend real
   * money answering a question nobody finished asking. Enter on an empty
   * argument still sends it, so nothing is harder to reach - it is one more
   * keypress for the case that wants no arguments, and a place to type for the
   * case that does.
   */
  const runCommand = (command: AgentSlashCommand): void => {
    if (command.kind === 'prompt') {
      setText(`/${command.name} `);
      ref.current?.focus();
      return;
    }
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
    // A builtin is what it does, not something to say to the model. A prompt
    // command is the opposite - it is only ever something to say - so it goes
    // out as the line the user typed and main turns it into the prompt behind
    // it on the way to the model.
    const typed = agentSlashCommand(trimmed, commands);
    if (typed?.command.kind === 'builtin') {
      runCommand(typed.command);
      return;
    }
    // Not sent, and not thrown away either: the draft stays exactly where it
    // was typed. Silently doing nothing is what makes this feel like a message
    // that vanished, so it is worth a line saying what happened.
    if (streaming) {
      setRefused(true);
      return;
    }
    // A message going out means a transcript that returns now has no home.
    droppedRef.current = true;
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
      // Cmd/Ctrl+Shift+V toggles dictation in this pane. Bubbles from the
      // focused textarea (or the button), so it only fires when this composer
      // is the one holding the key.
      onKeyDown={(e) => {
        if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== 'v') return;
        e.preventDefault();
        toggleVoice();
      }}
    >
      {refused && (
        <p role="status" className="px-1 pb-1.5 text-[11px] text-fleet-text-subtle">
          {asking
            ? 'Answer the question above first - your message is still here.'
            : 'The agent is still working - your message is still here.'}
        </p>
      )}
      {/* Amber rather than subtle: this is the one line here that is about
          something the next keystroke will do, not something already done. */}
      {armed && (
        <p role="status" className="px-1 pb-1.5 text-[11px] text-amber-700 dark:text-amber-400/90">
          Press Escape again to interrupt.
        </p>
      )}
      {attachError !== null && <Notice>{attachError}</Notice>}
      {blind && hasImage && (
        <Notice>
          This model cannot see images. It will be sent, but the model may ignore it - choose one
          with vision in Settings to have it looked at.
        </Notice>
      )}
      {voice.state.phase === 'error' && voice.state.error !== null && (
        <Notice>{voice.state.error}</Notice>
      )}
      {voice.state.phase === 'denied' && (
        <Notice>
          Microphone blocked. Grant it in System Settings, then click the mic to try again.
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
          <VoiceButton voice={voice} unavailable={!hasKey || disabled} />
          {voice.state.phase === 'recording' && (
            /* `h-7` rather than the row's `items-end`: the meter belongs on the
               same line as the paperclip and the mic, not sitting on the floor
               of a composer that has grown to several lines. */
            <span className="flex h-7 shrink-0 items-center gap-1 text-[10px] font-mono tabular-nums text-fleet-text-subtle">
              <span className="block h-1 w-8 shrink-0 overflow-hidden rounded-full bg-fleet-surface-3">
                <span
                  className="block h-full rounded-full bg-fleet-accent"
                  style={{ width: `${Math.max(4, voice.level * 100)}%` }}
                />
              </span>
              {/* Elapsed time while there is room, and only as the cap comes
                  into view does it turn into an amber countdown. A recording
                  that starts by counting down from a minute reads as a deadline
                  on a sentence that will take five seconds. */}
              {remaining < VOICE_COUNTDOWN_MS ? (
                <span className="text-amber-500">{(remaining / 1000).toFixed(1)}s left</span>
              ) : (
                <span>{(voice.elapsed / 1000).toFixed(1)}s</span>
              )}
            </span>
          )}
          {/* Beside the paperclip rather than out on the right: both are about
              what this message will do, and the right-hand side of the box is
              where sending it lives. */}
          <ToolModePicker value={toolMode} disabled={disabled} onChange={onToolMode} />
          <textarea
            ref={ref}
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(e) => {
              setText(e.target.value);
              // Said on every keystroke, so a question that arrives mid-sentence
              // waits for the sentence to end rather than for the next key.
              onDraft();
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
              const intent = composerIntent(e, {
                asking,
                streaming,
                armed,
                voice: voice.active,
                draft: text.trim() !== '' || attachments.length > 0
              });
              // Anything the composer has no opinion about is left alone
              // entirely, default included: these are the caret's keys.
              if (intent === 'pass') return;
              e.preventDefault();
              if (intent === 'voice') {
                cancelVoice();
                return;
              }
              if (intent === 'arm') {
                setArmed(true);
                return;
              }
              if (intent === 'interrupt') {
                setArmed(false);
                onStop();
                return;
              }
              if (intent === 'approve') {
                onApprove();
                return;
              }
              submit();
            }}
            // The turn is not listening here until the question above is
            // answered, so the box says what Enter does instead of leaving the
            // user to find out it no longer sends. The draft is left alone - it
            // is still worth sending after.
            placeholder={
              disabled
                ? 'Choose a coding model in Settings first'
                : voice.state.phase === 'recording'
                  ? holding
                    ? 'Release to insert · move away to discard'
                    : 'Recording… tap the mic to stop'
                  : voice.state.phase === 'transcribing'
                    ? 'Transcribing…'
                    : asking
                      ? 'Press Enter to run it, or answer above'
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
