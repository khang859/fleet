import { useEffect, useState } from 'react';
import { Bot, ChevronRight, X } from 'lucide-react';
import type { AgentTaskInfo, AgentToolCall } from '../../../../shared/agent-tools';
import type {
  AgentMessage,
  AgentPermissionAsk,
  AgentPermissionOutcome
} from '../../../../shared/agent-types';
import { AgentPermissionRow } from './AgentPermissionRow';
import { AgentToolRow } from './AgentToolRow';
import { AgentMarkdown } from './AgentMarkdown';
import { createLogger } from '../../logger';

const log = createLogger('agent:task-card');

/**
 * One subagent, on the row that started it.
 *
 * A card rather than an ordinary tool row because a subagent is not a tool
 * call: it is a second conversation, it takes minutes rather than seconds, and
 * the thing behind the disclosure is a transcript rather than a result. The
 * collapsed state is still one line, for the reason every tool row is - what
 * the user needs at a glance is which subagent, on what, and whether it is done.
 *
 * The transcript is fetched when the card is opened rather than held in the
 * pane. It is a conversation nobody watched, it is already on disk, and most of
 * them are never opened at all - loading every one into the pane's state would
 * be paying the context cost the subagent existed to avoid, on the one side of
 * the app that has no reason to.
 */
export function AgentTaskCard({
  call,
  activity,
  ask,
  onDecide
}: {
  call: AgentToolCall;
  /**
   * What the child is doing right now, from its own tool events. `undefined`
   * for one that is not running, and `null` for one that has not called
   * anything yet.
   */
  activity?: string | null;
  /** The command this subagent is stopped on, if it is stopped on one. */
  ask?: AgentPermissionAsk;
  onDecide: (taskId: string, outcome: AgentPermissionOutcome) => void;
}): React.JSX.Element {
  const task = call.task;
  const [open, setOpen] = useState(false);
  if (task === null) {
    // The row said it was a subagent and then had no subagent on it, which is a
    // dispatch that failed before it started - a name that is not a subagent, or
    // the cap. That is an ordinary failed call and reads better as one.
    return <AgentToolRow call={call} />;
  }

  const running = task.status === 'running';

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-fleet-border bg-fleet-glass-bg px-2.5 py-2 backdrop-blur-sm">
      {/* Stop sits beside the disclosure rather than inside it - a button
          inside a button is not markup a browser will keep - and on the same
          line rather than under it, since a row that is one line collapsed
          should not become two the moment something is running in it. */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring"
        >
          <ChevronRight
            size={12}
            className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          />
          <Bot size={12} className="shrink-0" />
          <span className={`shrink-0 ${running ? 'fleet-shimmer-text' : ''}`}>{task.agent}</span>
          {/* The prompt rather than a label, because with several subagents
              running the only thing that tells them apart is what each was
              asked - so it gets the row's spare width, and the status is
              capped rather than allowed to take it. An absolute path in a
              child's activity line is otherwise long enough on its own to
              leave the prompt at three words and an ellipsis. */}
          <span className="min-w-0 flex-1 truncate text-fleet-text-subtle">
            {oneLine(task.prompt)}
          </span>
          <span className="max-w-[40%] shrink-0 truncate pl-2">
            <Status task={task} activity={activity} />
          </span>
        </button>
        {running && (
          <button
            type="button"
            onClick={() => window.fleet.agent.cancelTask(task.id)}
            aria-label={`Stop the ${task.agent} subagent`}
            title="Stop this subagent"
            className="shrink-0 text-fleet-text-subtle transition-colors hover:text-fleet-text focus-ring"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {/* Outside the disclosure, so a question is on screen whether or not
          anyone had this card open. A subagent stopped on a command is stopped
          until it is answered, and a question behind a chevron is one nobody
          knows to look for. */}
      {ask !== undefined && (
        <AgentPermissionRow ask={ask} onDecide={(outcome) => onDecide(task.id, outcome)} />
      )}
      {open && <Body task={task} report={call.result} />}
    </div>
  );
}

/**
 * The right-hand end of the row.
 *
 * While it runs, what it is doing, because "running" for four minutes is
 * indistinguishable from stuck. Afterwards, how it ended - and the endings that
 * are not `done` are said in words and coloured, since those are the rows that
 * want noticing.
 */
function Status({
  task,
  activity
}: {
  task: AgentTaskInfo;
  activity: string | null | undefined;
}): React.JSX.Element {
  if (task.status === 'running') {
    return (
      <span className="fleet-shimmer-text font-mono text-[11px]">{activity ?? 'starting'}</span>
    );
  }
  if (task.status === 'done') {
    return <span className="text-fleet-text-subtle">{task.summary ?? 'reported'}</span>;
  }
  return <span className="text-amber-400/90">{task.status}</span>;
}

/**
 * What is behind the disclosure: what was asked, what came back, and then the
 * child's own transcript.
 *
 * In that order because it is the order of decreasing interest. The report is
 * what the parent acted on and is the thing worth reading; the transcript is
 * there for the times the report looks wrong and the question becomes what the
 * subagent actually saw.
 */
function Body({ task, report }: { task: AgentTaskInfo; report: string | null }): React.JSX.Element {
  return (
    // Capped, and the only scroller in the card. What is behind the disclosure
    // is a whole second conversation plus its report, which uncapped is several
    // screens - and a row that swallows the transcript when you open it is not
    // a disclosure, it is a page. One scroller rather than one per section, so
    // reading down the card never means finding the edge of an inner box first.
    <div className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto pl-4">
      <Section title="Asked">
        <pre className="text-[11px] leading-relaxed whitespace-pre-wrap text-fleet-text-muted">
          {task.prompt}
        </pre>
      </Section>
      {report !== null && task.status !== 'running' && (
        <Section title="Reported">
          <div className="text-sm text-fleet-text">
            {/* Never streaming: a report only exists once the subagent is done. */}
            <AgentMarkdown streaming={false}>{stripMarker(report)}</AgentMarkdown>
          </div>
        </Section>
      )}
      <Transcript taskId={task.id} running={task.status === 'running'} />
    </div>
  );
}

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] tracking-wide text-fleet-text-subtle uppercase">{title}</span>
      {children}
    </div>
  );
}

/**
 * The child's own conversation, read from its log.
 *
 * Read-only and rendered with the same rows the parent's transcript uses, so
 * "what did it look at" is answered in the vocabulary the user already knows.
 * Re-read while the subagent is still running, because a card opened mid-run is
 * the case where watching it is the whole point.
 */
function Transcript({ taskId, running }: { taskId: string; running: boolean }): React.JSX.Element {
  const [messages, setMessages] = useState<AgentMessage[] | null>(null);

  useEffect(() => {
    let live = true;
    const read = (): void => {
      void window.fleet.agent
        .taskTranscript(taskId)
        .then((replay) => {
          if (live) setMessages(replay.messages);
        })
        .catch((err: unknown) => log.warn('could not read a subagent transcript', { taskId, err }));
    };
    read();
    // Polled rather than pushed: the child's rounds are minutes apart, and a
    // card nobody has opened should cost nothing at all - which a live
    // subscription running for every dispatched subagent would not.
    const timer = running ? setInterval(read, 2000) : null;
    return () => {
      live = false;
      if (timer !== null) clearInterval(timer);
    };
  }, [taskId, running]);

  if (messages === null) return <Section title="Transcript">{null}</Section>;
  if (messages.length === 0) {
    return (
      <Section title="Transcript">
        <span className="text-[11px] text-fleet-text-subtle">
          {running ? 'Nothing yet.' : 'This subagent recorded nothing.'}
        </span>
      </Section>
    );
  }

  return (
    <Section title="Transcript">
      <div className="flex flex-col gap-2">
        {messages.map((message) => (
          <div key={message.id} className="flex flex-col gap-1.5">
            {message.parts.map((part, i) =>
              part.type === 'text' ? (
                <div key={i} className="text-[13px] text-fleet-text-muted">
                  {/* Read from the log, so always a finished message. */}
                  <AgentMarkdown streaming={false}>{part.text}</AgentMarkdown>
                </div>
              ) : part.type === 'tool' ? (
                <AgentToolRow key={i} call={part.call} />
              ) : null
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

/** The prompt as a single line, for a row that has one. */
function oneLine(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim();
}

/**
 * The report without the fence Fleet wrapped it in.
 *
 * The fence is there so the *model* reads the report as a claim from a
 * subagent. The user is looking at a card that already says which subagent this
 * is, so on screen it would be markup explaining something the layout has
 * already explained.
 */
function stripMarker(report: string): string {
  const opened = report.indexOf('\n');
  const closed = report.lastIndexOf('</fleet_subagent_report>');
  if (!report.startsWith('<fleet_subagent_report') || closed === -1) return report;
  return report.slice(opened + 1, closed).trim();
}
