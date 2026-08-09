import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import {
  MAX_PARALLEL_TASKS,
  MAX_TASKS_PER_THREAD,
  resolveTaskModel,
  resolveTaskTools,
  type SubagentDefinition
} from '../../../shared/agent-subagents';
import type { AgentTaskInfo, AgentTaskStatus, SubagentToolName } from '../../../shared/agent-tools';
import type {
  AgentMessage,
  AgentTaskDone,
  AgentTaskStart,
  AgentTurnUsage
} from '../../../shared/agent-types';
import { sanitizeReport } from '../../../shared/subagent-report';
import type { AgentSessionReplay } from '../../../shared/agent-session';
import { AgentSessionStore } from '../session-store';
import { createLogger } from '../../logger';
import { loadSubagents } from './definitions';

const log = createLogger('agent:subagents');

/** Where a subagent's own transcript is kept, beside the sessions it serves. */
const TASKS_DIR = join(homedir(), '.fleet', 'agent', 'tasks');

/**
 * What running one subagent takes, once the definition has been found and the
 * call's overrides folded in.
 */
export type TaskRun = {
  taskId: string;
  definition: SubagentDefinition;
  prompt: string;
  tools: SubagentToolName[];
  model: string;
  cwd: string;
  signal: AbortSignal;
  /**
   * One completed round of the child's own conversation, on its way to the
   * child's log. Main keeps this rather than a pane, because a subagent is the
   * one conversation in Fleet that nobody was watching while it happened.
   */
  onMessage: (message: AgentMessage) => void;
};

/** What a run gave back: its answer, and what it spent getting there. */
export type TaskOutcome = { report: string; usage: AgentTurnUsage | null };

/**
 * One subagent that has not reported yet, as the parent's next round is told
 * about it. Its own id doubles as its stream, which is how the permission gate
 * is asked whether it is stopped on a question.
 */
export type LiveSubagent = { taskId: string; agent: string; prompt: string };

/**
 * A run that ended without an answer, carrying what it spent anyway.
 *
 * A subclass rather than a return value, because everything below the runner
 * signals failure by throwing and wrapping all of that would mean catching it
 * twice. What is added is the one thing a plain `Error` loses and the user
 * would notice: a subagent that ran for four rounds and then hit the ceiling
 * was billed for four rounds.
 */
export class TaskFailure extends Error {
  constructor(
    message: string,
    readonly usage: AgentTurnUsage | null
  ) {
    super(message);
    this.name = 'TaskFailure';
  }
}

/**
 * A dispatch declined because the machine is already running as many subagents
 * as it will.
 *
 * Its own type because it is the one refusal here that does not mean anything
 * went wrong. "There is no subagent called X" will be true next round too; this
 * one stops being true as soon as a slot frees, and the model is expected to
 * try again - which is exactly what it does. Told apart from a real failure by
 * its type rather than by its sentence, so the wording stays free to change.
 */
export class SubagentCapReached extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubagentCapReached';
  }
}

type Deps = {
  emit: (channel: string, payload: unknown) => void;
  /** Runs one child turn. `AgentService` supplies this; a subagent *is* a turn. */
  run: (run: TaskRun) => Promise<TaskOutcome>;
  /** Injectable for tests. */
  sessions?: AgentSessionStore;
  definitions?: (cwd: string) => Promise<SubagentDefinition[]>;
};

/** One dispatched subagent, while it is running. */
type Live = {
  info: AgentTaskInfo;
  /** The session to report back to, the row inside it, and its folder. */
  parent: { threadId: string; callId: string; cwd: string };
  controller: AbortController;
};

/**
 * Every subagent that is running, and the way to start another.
 *
 * A registry rather than a promise the caller holds, because a subagent outlives
 * the turn that dispatched it: the tool call returns as soon as the child is
 * started, the turn ends, the composer re-enables, and the report arrives some
 * minutes later addressed to a pane rather than to a stream. Something has to
 * hold the middle of that, and it cannot be the turn.
 *
 * The cap is app-wide for the reason it is written app-wide in
 * `agent-subagents`: what it protects is the rate limit and the money, and both
 * of those belong to the machine rather than to any one pane.
 */
export class SubagentManager {
  private readonly live = new Map<string, Live>();
  private readonly sessions: AgentSessionStore;
  private readonly definitions: (cwd: string) => Promise<SubagentDefinition[]>;

  constructor(private readonly deps: Deps) {
    this.sessions = deps.sessions ?? new AgentSessionStore(TASKS_DIR);
    this.definitions = deps.definitions ?? loadSubagents;
  }

  /** Every definition a pane on `cwd` may dispatch. */
  async list(cwd: string): Promise<SubagentDefinition[]> {
    return this.definitions(cwd);
  }

  /**
   * Which of these are still running.
   *
   * Asked rather than told, because the question comes from a pane that has
   * just replayed a session and found rows saying "running" - and those rows
   * were written by a renderer that has since been reloaded, or by a launch of
   * the app that ended last week. The ones that come back are real; the rest
   * ended without anyone writing it down, and the pane says so.
   */
  runningAmong(taskIds: string[]): string[] {
    return taskIds.filter((id) => this.live.has(id));
  }

  /** Every subagent running right now, by id. */
  liveIds(): string[] {
    return [...this.live.keys()];
  }

  /**
   * The children one conversation started and is still waiting on.
   *
   * By thread rather than by id, because the caller is a turn rather than a
   * pane that has just reloaded: what it wants is not "are these still alive"
   * but "what is out there in my name". A child asks and gets nothing back -
   * its thread id is its own task id, which nothing is ever the parent of.
   */
  runningFor(threadId: string): LiveSubagent[] {
    return [...this.live.values()]
      .filter((entry) => entry.parent.threadId === threadId)
      .map((entry) => ({
        taskId: entry.info.id,
        agent: entry.info.agent,
        prompt: entry.info.prompt
      }));
  }

  /**
   * Start one, and answer at once.
   *
   * The refusals are thrown rather than returned as a status, because they are
   * all cases where nothing started: a name that is not a subagent, and a
   * machine already running as many as it will. `runAgentTool` turns a throw
   * into text the model reads and can act on - which for the cap means trying
   * again next round, and for the name means picking a real one.
   *
   * The cap throws a type of its own, because those two are the same to the
   * model and not to the user: one is a mistake and the other is a queue. See
   * `SubagentCapReached`, and `runTask`, which is where the difference is spent.
   */
  async dispatch(req: {
    agent: string;
    prompt: string;
    tools: SubagentToolName[] | null;
    parentModel: string;
    threadId: string;
    callId: string;
    cwd: string;
  }): Promise<AgentTaskInfo> {
    // Counted and claimed without an await in between. Reading the folder of
    // definitions is real disk work, and two panes dispatching at the same
    // moment would both wake from it having seen the same count and both take
    // the last slot. The cap is about the rate limit and the bill, so a cap
    // that holds only when nothing happens at once is not a cap.
    if (this.live.size >= MAX_PARALLEL_TASKS) {
      throw new SubagentCapReached(
        `${MAX_PARALLEL_TASKS} subagents are already running, which is as many as Fleet will run at once. Wait for one to report back and dispatch this again.`
      );
    }
    // And no one conversation may hold all of them. See `MAX_TASKS_PER_THREAD`:
    // this is what stops a model that fans out wide from refusing every other
    // pane in the app for as long as its children run.
    if (this.runningFor(req.threadId).length >= MAX_TASKS_PER_THREAD) {
      throw new SubagentCapReached(
        `This conversation already has ${MAX_TASKS_PER_THREAD} subagents running, which is as many as one conversation runs at once. Wait for one to report back and dispatch this again.`
      );
    }

    const taskId = randomUUID();
    const info: AgentTaskInfo = {
      id: taskId,
      agent: req.agent,
      prompt: req.prompt,
      status: 'running',
      summary: null
    };
    const controller = new AbortController();
    this.live.set(taskId, {
      info,
      parent: { threadId: req.threadId, callId: req.callId, cwd: req.cwd },
      controller
    });

    const definition = (await this.list(req.cwd)).find((d) => d.name === req.agent) ?? null;
    if (definition === null) {
      // Nothing started, so the slot goes straight back - held only for as long
      // as it took to find out this was not a subagent at all.
      this.live.delete(taskId);
      throw new Error(`There is no subagent called "${req.agent}".`);
    }

    // Before the run starts, so the pane knows what the child's stream id means
    // by the time the first of the child's tool events arrives on it.
    this.deps.emit(IPC_CHANNELS.AGENT_TASK_START, {
      threadId: req.threadId,
      callId: req.callId,
      task: info
    } satisfies AgentTaskStart);

    void this.execute(taskId, {
      taskId,
      definition,
      prompt: req.prompt,
      tools: resolveTaskTools(definition.tools, req.tools),
      model: resolveTaskModel(definition.model, req.parentModel),
      cwd: req.cwd,
      signal: controller.signal,
      onMessage: (message) => this.sessions.append(taskId, req.cwd, { t: 'message', message })
    });

    return info;
  }

  /** The child's own transcript, for the card the user opened. */
  transcript(taskId: string): AgentSessionReplay {
    return this.sessions.load(taskId);
  }

  /** Stop one, on the user's say-so. It reports back as `cancelled`. */
  cancel(taskId: string): void {
    this.live.get(taskId)?.controller.abort();
  }

  /**
   * Stop all of them, on the way out.
   *
   * Every one still running is written down as `interrupted` rather than left
   * as `running`, so a card reopened tomorrow says what happened. The alternative
   * is a row that shimmers forever waiting on a process that ended last week.
   */
  cancelAll(): void {
    for (const [taskId, entry] of this.live) {
      entry.controller.abort();
      this.finish(taskId, 'interrupted', 'Fleet closed before this subagent finished.', null);
    }
    this.live.clear();
  }

  private async execute(taskId: string, run: TaskRun): Promise<void> {
    try {
      const outcome = await this.deps.run(run);
      this.finish(taskId, 'done', outcome.report, outcome.usage);
    } catch (err) {
      const aborted = run.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      if (!aborted) log.warn(`subagent ${run.definition.name} failed`, { taskId, message });
      this.finish(
        taskId,
        aborted ? 'cancelled' : 'failed',
        aborted
          ? 'The user stopped this subagent before it finished. Nothing came back.'
          : `This subagent stopped without answering: ${message}`,
        // A run that failed or was stopped still spent whatever it spent, and
        // the runner reports that on the error rather than losing it.
        err instanceof TaskFailure ? err.usage : null
      );
    }
  }

  /**
   * Tell the pane how it ended, exactly once.
   *
   * Guarded on the entry still being there, because `cancelAll` writes an
   * ending for everything it aborts and the aborted run reaches `execute`'s
   * catch a moment later with its own. The first ending is the true one - it is
   * the one that says why.
   */
  private finish(
    taskId: string,
    status: AgentTaskStatus,
    report: string,
    usage: AgentTurnUsage | null
  ): void {
    const entry = this.live.get(taskId);
    if (entry === undefined) return;
    this.live.delete(taskId);

    const task: AgentTaskInfo = { ...entry.info, status, summary: summarize(status, report) };
    this.deps.emit(IPC_CHANNELS.AGENT_TASK_DONE, {
      threadId: entry.parent.threadId,
      callId: entry.parent.callId,
      cwd: entry.parent.cwd,
      task,
      // Framed even when Fleet wrote the text itself, so the parent sees one
      // shape for "what came back from a subagent" rather than two.
      report: sanitizeReport(entry.info.agent, report),
      usage
    } satisfies AgentTaskDone);
  }
}

/**
 * The line on the collapsed row.
 *
 * A size for the ordinary ending, because "what did it say" is behind the
 * disclosure and what the row is for is knowing whether to open it. Anything
 * other than `done` is said in words instead: those are the rows the user needs
 * to notice, and a word count would hide exactly the ones that matter.
 */
function summarize(status: AgentTaskStatus, report: string): string {
  if (status === 'done') {
    const words = report.trim().split(/\s+/).filter(Boolean).length;
    return `${words.toLocaleString('en-US')} ${words === 1 ? 'word' : 'words'}`;
  }
  return status;
}
