import {
  BACKGROUND_MAX_JOBS,
  BACKGROUND_MAX_MS,
  BASH_MAX_OUTPUT_CHARS,
  OUTPUT_SEPARATOR,
  type AgentBackgroundJob,
  type AgentToolContext,
  type AgentToolResult,
  type BashKillArgs,
  type BashOutputArgs,
  type BackgroundStopReason
} from '../../../shared/agent-tools';
import { shellError, spawnShell, stopTree, type ShellProcess } from './shell';

/**
 * Commands that outlive the turn that started them.
 *
 * `bash` is the right shape for a command with an end - a build, a test run, a
 * `git status` - and no shape at all for a dev server, a watch build or
 * anything else whose whole job is to keep running. Waiting on one of those
 * means the turn is over: the timeout fires, the server dies with it, and the
 * agent never gets to the part where it checks whether the page renders.
 *
 * So the command is started, an id comes back, and the turn carries on. What it
 * has printed since is read with `bash_output`, and it is stopped with
 * `bash_kill`. That is the same three-part shape every harness that has shipped
 * this landed on, and the reason is that the alternative - a tool that streams -
 * has no answer for what the model is supposed to do while it streams.
 *
 * Two things are held against it, both of them about a process nobody is
 * watching any more:
 *
 * - A conversation may hold `BACKGROUND_MAX_JOBS` of these at once. Finished
 *   ones are cleared out to make room; running ones are not, so a model that
 *   starts servers in a loop is told to stop one rather than quietly filling
 *   the machine.
 * - Nothing runs past `BACKGROUND_MAX_MS`. A subagent ending and a pane closing
 *   are both told to this file - `killThreadBackgroundCommands` and
 *   `stopThreadBackgroundCommands` - and quitting kills the rest, but the
 *   ceiling is what guarantees that a forgotten `npm run dev` is not still
 *   running at midnight whatever else goes wrong.
 *
 * The user sees them too. Whenever a conversation's running set changes, or
 * one of them prints a new last line, the listener is handed the whole list,
 * which main pushes to the pane - so a server the model started is on screen
 * with a stop button rather than only in the model's head.
 *
 * Nothing here survives a restart, which is the honest state of affairs: the
 * processes do not either.
 */

/** How a background command is doing, which is not the same as what it printed. */
export type BackgroundStatus = 'running' | 'exited' | 'stopped' | 'expired';

type Job = {
  id: string;
  threadId: string;
  command: string;
  child: ShellProcess;
  startedAt: number;
  endedAt: number | null;
  status: BackgroundStatus;
  /** Set when someone other than the model stopped it, so the model is told who. */
  stoppedBy: BackgroundStopReason | null;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Output that has arrived and not been handed over yet. */
  pending: Pending;
  /**
   * The end of what it has printed, kept apart from `pending` because reading
   * that empties it, and the last line is wanted whether or not the model has
   * looked. Only as much as can hold one line of it.
   */
  tail: string;
  lastLine: string | null;
  /** Cleared the moment the command ends, so a finished job holds no timer. */
  deadline: NodeJS.Timeout | null;
  /** The hard kill that follows a polite one, if the polite one was ignored. */
  hard: NodeJS.Timeout | null;
};

/**
 * Conversation, then job. Nested for the reason the freshness record is nested:
 * both halves are free-form, and a job started in one pane is not a job another
 * pane may read or stop.
 */
const jobs = new Map<string, Map<string, Job>>();

/** Ids count up per conversation, so they stay short enough to read on a row. */
const counters = new Map<string, number>();

/**
 * How often a conversation's list may be pushed because of output alone.
 *
 * A start or an end goes out at once; a new last line waits for this. A watch
 * build or a chatty server prints dozens of lines a second, and a pane redrawn
 * that often for a line nobody can read that fast is load with nothing to show
 * for it.
 */
export const BACKGROUND_NOTIFY_MS = 1_000;

/** How much of the end of the output is kept to find its last line in. */
const TAIL_CHARS = 4_096;

/** How much of a last line is kept. A row is 272px wide; this is generous. */
const LAST_LINE_CHARS = 200;

type Listener = (threadId: string, jobs: AgentBackgroundJob[]) => void;

let listener: Listener = () => {};

/** Output-driven pushes waiting out `BACKGROUND_NOTIFY_MS`, by conversation. */
const notifyTimers = new Map<string, NodeJS.Timeout>();

/**
 * Who hears about a conversation's running commands changing. One listener,
 * set once by main at startup, which is all there is to tell.
 */
export function setBackgroundListener(next: Listener): void {
  listener = next;
}

/**
 * Start a command and leave it running.
 *
 * The id is what the model has to hold on to, so it is the first thing the
 * result says and the only thing the row's summary shows.
 */
export function startBackgroundCommand(
  command: string,
  ctx: AgentToolContext
): { id: string; text: string; summary: string } {
  const mine = jobs.get(ctx.threadId) ?? new Map<string, Job>();
  makeRoom(mine);

  const n = (counters.get(ctx.threadId) ?? 0) + 1;
  counters.set(ctx.threadId, n);
  const id = `bg_${n}`;

  let child: ShellProcess;
  try {
    child = spawnShell(command, ctx.cwd);
  } catch (err) {
    throw shellError(err instanceof Error ? err : new Error(String(err)));
  }

  const job: Job = {
    id,
    threadId: ctx.threadId,
    command,
    child,
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    stoppedBy: null,
    code: null,
    signal: null,
    pending: makePending(),
    tail: '',
    lastLine: null,
    deadline: null,
    hard: null
  };

  const onOutput = (chunk: string): void => {
    job.pending.push(chunk);
    job.tail = (job.tail + chunk).slice(-TAIL_CHARS);
    const line = lastLineOf(job.tail);
    if (line !== null && line !== job.lastLine) {
      job.lastLine = line;
      notifySoon(job.threadId);
    }
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  // A shell that could not start is an ending like any other, so it is recorded
  // rather than thrown: the call has already returned an id by the time this
  // can fire, and the next `bash_output` is where the model finds out.
  child.on('error', (err) => {
    job.pending.push(`\n${shellError(err).message}\n`);
    end(job, 'exited');
  });
  child.on('close', (code, signal) => {
    job.code = code;
    job.signal = signal;
    end(job, job.status === 'running' ? 'exited' : job.status);
  });

  job.deadline = setTimeout(() => {
    if (job.status !== 'running') return;
    job.status = 'expired';
    job.hard = stopTree(child);
    notify(job.threadId);
  }, BACKGROUND_MAX_MS);
  // A command nobody is waiting on should not be the reason the process stays
  // up, and in tests it is the difference between a run that ends and one that
  // hangs for an hour.
  job.deadline.unref();

  mine.set(id, job);
  jobs.set(ctx.threadId, mine);
  notify(ctx.threadId);

  return {
    id,
    text: [
      `Started in the background as ${id}. It is still running, and it keeps running after this turn ends.`,
      `Read what it has printed with bash_output on ${id}, and stop it with bash_kill on ${id} once you are done with it.`,
      `Nothing is kept running past ${Math.round(BACKGROUND_MAX_MS / 60_000)} minutes.`
    ].join(' '),
    summary: `${id} started`
  };
}

/** What one has printed since it was last looked at, and how it is doing. */
export function readBackgroundCommand(
  args: BashOutputArgs,
  ctx: AgentToolContext
): AgentToolResult {
  const job = find(args.id, ctx.threadId);
  const { text, dropped } = job.pending.drain();

  return {
    text: [
      headline(job),
      ...(dropped === 0
        ? []
        : [
            `${dropped.toLocaleString('en-US')} characters printed before this were dropped - only the most recent ${BASH_MAX_OUTPUT_CHARS.toLocaleString('en-US')} are kept between reads.`
          ]),
      OUTPUT_SEPARATOR,
      text === '' ? 'Nothing new since you last looked.' : text
    ].join('\n'),
    summary: summarize(job, text)
  };
}

/** Stop one, and hand over whatever it had left to say. */
export function killBackgroundCommand(args: BashKillArgs, ctx: AgentToolContext): AgentToolResult {
  const job = find(args.id, ctx.threadId);
  const wasRunning = job.status === 'running';
  stop(job, null);

  const { text } = job.pending.drain();
  return {
    text: [
      wasRunning
        ? `${job.id} was stopped, along with everything it had started. Anything it had printed and you had not read is below.`
        : job.status === 'exited'
          ? `${job.id} had already finished. ${headline(job)}`
          : headline(job),
      OUTPUT_SEPARATOR,
      text === '' ? 'Nothing left unread.' : text
    ].join('\n'),
    summary: `${job.id} stopped`
  };
}

/**
 * The user's stop button on one of them.
 *
 * Stopped rather than forgotten: the model may still hold the id, and its next
 * `bash_output` should say the user stopped it rather than that it never
 * existed. `false` for an id that is not running, which is a row that was
 * already on its way off the screen.
 */
export function stopBackgroundCommand(threadId: string, id: string): boolean {
  const job = jobs.get(threadId)?.get(id);
  if (job?.status !== 'running') return false;
  stop(job, 'user');
  return true;
}

/**
 * Stop everything one conversation has running, because the last pane showing
 * it closed. The records stay, for the same reason as a single stop: the
 * conversation can be reopened, and its model told what happened.
 */
export function stopThreadBackgroundCommands(threadId: string, reason: BackgroundStopReason): void {
  for (const job of jobs.get(threadId)?.values() ?? []) stop(job, reason);
}

/** What one conversation has running, oldest first - what a pane draws. */
export function listBackgroundCommands(threadId: string): AgentBackgroundJob[] {
  const out: AgentBackgroundJob[] = [];
  for (const job of jobs.get(threadId)?.values() ?? []) {
    if (job.status !== 'running') continue;
    out.push({
      id: job.id,
      command: job.command,
      startedAt: job.startedAt,
      lastLine: job.lastLine
    });
  }
  return out;
}

/**
 * Stop everything one conversation started.
 *
 * Called when a subagent finishes, which is the one ending this file can be
 * told about: a child reports once and is gone, so a process of its own left
 * running has nobody left to read it or stop it.
 */
export function killThreadBackgroundCommands(threadId: string): void {
  const mine = jobs.get(threadId);
  if (mine === undefined) return;
  for (const job of mine.values()) forget(job);
  jobs.delete(threadId);
  counters.delete(threadId);
  clearNotify(threadId);
}

/**
 * Everything still running, on the way out - the describing half of
 * {@link killAllBackgroundCommands}.
 *
 * Labelled by the command itself rather than by owner: jobs are keyed by
 * thread id, which main has no map from to a pane the user would recognise,
 * and `npm run dev` is the thing they need to see to judge whether losing it
 * matters anyway.
 */
export function listRunningBackgroundCommands(): Array<{ id: string; command: string }> {
  const out: Array<{ id: string; command: string }> = [];
  for (const mine of jobs.values()) {
    for (const job of mine.values()) {
      if (job.status === 'running') out.push({ id: job.id, command: job.command });
    }
  }
  return out;
}

/** Stop everything, on the way out. Anything left here is a process we own. */
export function killAllBackgroundCommands(): void {
  for (const mine of jobs.values()) for (const job of mine.values()) forget(job);
  jobs.clear();
  counters.clear();
  for (const threadId of [...notifyTimers.keys()]) clearNotify(threadId);
}

function find(id: string, threadId: string): Job {
  const job = jobs.get(threadId)?.get(id);
  if (job !== undefined) return job;

  const known = [...(jobs.get(threadId)?.keys() ?? [])];
  throw new Error(
    known.length === 0
      ? `There is no background command called ${id} - this conversation has not started any, or they have all been cleared away.`
      : `There is no background command called ${id}. The ones this conversation has are ${known.join(', ')}.`
  );
}

/** Record how it ended, once, and let go of the timers that were watching it. */
function end(job: Job, status: BackgroundStatus): void {
  if (job.endedAt !== null) return;
  job.endedAt = Date.now();
  job.status = status;
  if (job.deadline !== null) clearTimeout(job.deadline);
  if (job.hard !== null) clearTimeout(job.hard);
  job.deadline = null;
  job.hard = null;
  notify(job.threadId);
}

/**
 * Ask a running one to stop. The hard kill that may follow is left armed, and
 * `end` clears it once the process is gone.
 */
function stop(job: Job, by: BackgroundStopReason | null): void {
  if (job.status !== 'running') return;
  job.status = 'stopped';
  job.stoppedBy = by;
  job.hard = stopTree(job.child);
  // Now rather than from `end`: a process that takes its grace period to die
  // would otherwise sit in the pane as running, stop button and all.
  notify(job.threadId);
}

/** Tell the listener now, dropping any output-driven push still waiting. */
function notify(threadId: string): void {
  clearNotify(threadId);
  listener(threadId, listBackgroundCommands(threadId));
}

/** Tell the listener once `BACKGROUND_NOTIFY_MS` is up, unless it is already due. */
function notifySoon(threadId: string): void {
  if (notifyTimers.has(threadId)) return;
  const timer = setTimeout(() => notify(threadId), BACKGROUND_NOTIFY_MS);
  // The same reason the deadline is unref'd: a push nobody asked for should not
  // be what keeps the process, or a test run, alive.
  timer.unref();
  notifyTimers.set(threadId, timer);
}

function clearNotify(threadId: string): void {
  const timer = notifyTimers.get(threadId);
  if (timer === undefined) return;
  clearTimeout(timer);
  notifyTimers.delete(threadId);
}

/**
 * Colour codes, cursor moves and window titles: everything a terminal would act
 * on rather than print. A dev server colours its `ready` line, and the codes
 * around it are noise in a row that is not a terminal.
 */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/**
 * The last line of some output that has anything on it, as a terminal would
 * show it.
 *
 * Within a line, the last carriage-return segment with anything on it, because
 * that is how a progress bar redraws itself: `\r` and the whole line again, a
 * hundred times, and only the last of them is still on screen. A `\r\n` line
 * ending is the same rule with an empty last segment. Exported for its tests.
 */
export function lastLineOf(text: string): string | null {
  const segments = text
    .replace(ESCAPES, '')
    .split('\n')
    .flatMap((line) => line.split('\r'));
  for (let i = segments.length - 1; i >= 0; i--) {
    const line = segments[i].replace(/\s+/g, ' ').trim();
    if (line === '') continue;
    return line.length > LAST_LINE_CHARS ? `${line.slice(0, LAST_LINE_CHARS - 1)}\u2026` : line;
  }
  return null;
}

/** Kill it if it is still going, and stop holding anything about it. */
function forget(job: Job): void {
  // Ended rather than running: one already asked to stop may still be inside
  // its grace period, and the hard kill cleared below is the one that was
  // going to finish it.
  if (job.endedAt === null) stopTree(job.child).unref();
  if (job.deadline !== null) clearTimeout(job.deadline);
  if (job.hard !== null) clearTimeout(job.hard);
}

/**
 * Room for one more, or a refusal.
 *
 * Finished jobs are dropped oldest first, because a job that has ended has
 * already had its output read or has been abandoned, and either way its slot is
 * worth more than its record. Running ones are never dropped for a newcomer:
 * that would kill a server the model is mid-way through using, and the model
 * would find out through a page that stopped answering rather than through an
 * error it could act on.
 */
function makeRoom(mine: Map<string, Job>): void {
  const finished = [...mine.values()]
    .filter((job) => job.endedAt !== null)
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));

  while (mine.size >= BACKGROUND_MAX_JOBS && finished.length > 0) {
    const job = finished.shift();
    if (job === undefined) break;
    forget(job);
    mine.delete(job.id);
  }

  if (mine.size >= BACKGROUND_MAX_JOBS) {
    throw new Error(
      `This conversation already has ${BACKGROUND_MAX_JOBS} background commands running, which is as many as it may hold. Stop one with bash_kill before starting another.`
    );
  }
}

function headline(job: Job): string {
  const took = `${(((job.endedAt ?? Date.now()) - job.startedAt) / 1000).toFixed(1)}s`;
  switch (job.status) {
    case 'running':
      return `${job.id} \`${job.command}\` is still running, ${took} in.`;
    case 'stopped':
      return job.stoppedBy === 'user'
        ? `${job.id} \`${job.command}\` was stopped by the user after ${took}.`
        : job.stoppedBy === 'pane-closed'
          ? `${job.id} \`${job.command}\` was stopped after ${took}, when the pane showing this conversation was closed.`
          : `${job.id} \`${job.command}\` was stopped after ${took}.`;
    case 'expired':
      return `${job.id} \`${job.command}\` was killed after ${took}, at the ${Math.round(BACKGROUND_MAX_MS / 60_000)} minute ceiling on a background command. Start it again if you still need it.`;
    case 'exited':
      if (job.code === 0) return `${job.id} \`${job.command}\` finished in ${took}.`;
      return job.code === null
        ? `${job.id} \`${job.command}\` was killed by ${job.signal ?? 'a signal'} after ${took}.`
        : `${job.id} \`${job.command}\` ended with exit status ${job.code} after ${took}.`;
  }
}

function summarize(job: Job, text: string): string {
  const lines = text === '' ? 0 : text.split('\n').length;
  const output = lines === 0 ? 'nothing new' : `${lines} line${lines === 1 ? '' : 's'}`;
  switch (job.status) {
    case 'running':
      return `running, ${output}`;
    case 'stopped':
      return `${job.stoppedBy === 'user' ? 'stopped by the user' : 'stopped'}, ${output}`;
    case 'expired':
      return `killed at the time limit, ${output}`;
    case 'exited':
      return `${job.code === 0 ? 'finished' : `exit ${job.code ?? 'killed'}`}, ${output}`;
  }
}

type Pending = { push: (chunk: string) => void; drain: () => { text: string; dropped: number } };

/**
 * What has arrived and not been handed over.
 *
 * Kept from the end rather than from both ends, which is the opposite of what a
 * finished command's output does and right for the same reason: this answers
 * "what has it printed since I last looked", and a watch build that has looped
 * four hundred times is telling you about the last loop. A cap either way,
 * because a server left unread for an hour would otherwise be a memory leak
 * with a log level.
 */
function makePending(): Pending {
  const kept = { text: '', dropped: 0 };

  return {
    push(chunk: string): void {
      kept.text += chunk;
      if (kept.text.length > BASH_MAX_OUTPUT_CHARS) {
        kept.dropped += kept.text.length - BASH_MAX_OUTPUT_CHARS;
        kept.text = kept.text.slice(kept.text.length - BASH_MAX_OUTPUT_CHARS);
      }
    },
    drain(): { text: string; dropped: number } {
      const out = { text: kept.text, dropped: kept.dropped };
      kept.text = '';
      kept.dropped = 0;
      return out;
    }
  };
}
