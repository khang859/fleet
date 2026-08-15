import {
  BACKGROUND_MAX_JOBS,
  BACKGROUND_MAX_MS,
  BASH_MAX_OUTPUT_CHARS,
  OUTPUT_SEPARATOR,
  type AgentToolContext,
  type AgentToolResult,
  type BashKillArgs,
  type BashOutputArgs
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
 * - Nothing runs past `BACKGROUND_MAX_MS`. A pane can be closed and a subagent
 *   can end, and neither of those is a signal this file can see from here, so
 *   the ceiling is what guarantees that a forgotten `npm run dev` is not still
 *   running at midnight. `killThreadBackgroundCommands` covers the endings that
 *   *are* visible, and quitting covers the rest.
 *
 * Nothing here survives a restart, which is the honest state of affairs: the
 * processes do not either.
 */

/** How a background command is doing, which is not the same as what it printed. */
export type BackgroundStatus = 'running' | 'exited' | 'stopped' | 'expired';

type Job = {
  id: string;
  command: string;
  child: ShellProcess;
  startedAt: number;
  endedAt: number | null;
  status: BackgroundStatus;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Output that has arrived and not been handed over yet. */
  pending: Pending;
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
    command,
    child,
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    code: null,
    signal: null,
    pending: makePending(),
    deadline: null,
    hard: null
  };

  child.stdout.on('data', (chunk: string) => job.pending.push(chunk));
  child.stderr.on('data', (chunk: string) => job.pending.push(chunk));
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
  }, BACKGROUND_MAX_MS);
  // A command nobody is waiting on should not be the reason the process stays
  // up, and in tests it is the difference between a run that ends and one that
  // hangs for an hour.
  job.deadline.unref();

  mine.set(id, job);
  jobs.set(ctx.threadId, mine);

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

  if (job.status === 'running') {
    job.status = 'stopped';
    job.hard = stopTree(job.child);
  }

  const { text } = job.pending.drain();
  return {
    text: [
      job.endedAt === null
        ? `${job.id} was stopped, along with everything it had started. Anything it had printed and you had not read is below.`
        : `${job.id} had already finished. ${headline(job)}`,
      OUTPUT_SEPARATOR,
      text === '' ? 'Nothing left unread.' : text
    ].join('\n'),
    summary: `${job.id} stopped`
  };
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
}

/** Stop everything, on the way out. Anything left here is a process we own. */
export function killAllBackgroundCommands(): void {
  for (const mine of jobs.values()) for (const job of mine.values()) forget(job);
  jobs.clear();
  counters.clear();
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
}

/** Kill it if it is still going, and stop holding anything about it. */
function forget(job: Job): void {
  if (job.status === 'running') stopTree(job.child).unref();
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
      return `${job.id} \`${job.command}\` was stopped after ${took}.`;
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
      return `stopped, ${output}`;
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
