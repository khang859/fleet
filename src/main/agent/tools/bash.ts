import { spawn, type ChildProcess } from 'node:child_process';
import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_OUTPUT_CHARS,
  OUTPUT_SEPARATOR,
  type AgentToolContext,
  type AgentToolResult,
  type BashArgs
} from '../../../shared/agent-tools';
import { splitLines } from '../../../shared/agent-diff';

/**
 * Run a shell command in the pane's folder.
 *
 * This is the one tool with no sandbox. `read` and `edit` refuse a path outside
 * the working folder; a shell can write anywhere the user can, and a blocklist
 * of dangerous commands would be theatre - a variable, an alias, a two-line
 * script all walk straight past one. So the honest position is that this tool
 * does what the model asked for, the folder is only where it starts, and what
 * makes it safe is a permission step, which is its own piece of work.
 *
 * Each call is its own process. A `cd` does not carry over to the next call and
 * neither does an exported variable - which the tool's description says plainly,
 * because a model that believes otherwise writes commands that quietly run
 * somewhere else.
 */
export async function runBash(args: BashArgs, ctx: AgentToolContext): Promise<AgentToolResult> {
  const timeoutMs = args.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS;
  const run = await execute(args.command, ctx, timeoutMs);

  return {
    text: [
      headline(run, timeoutMs),
      ...instead(args.command),
      OUTPUT_SEPARATOR,
      run.output === '' ? 'No output.' : run.output
    ].join('\n'),
    summary: summarize(run)
  };
}

/** How a command ended, which is not the same question as what it printed. */
type Ending = 'ok' | 'failed' | 'timeout' | 'stopped';

type Run = {
  output: string;
  /** `null` when a signal killed it before it could choose a status. */
  code: number | null;
  signal: NodeJS.Signals | null;
  ending: Ending;
  ms: number;
};

/**
 * The shell. Non-login and non-interactive on purpose: a login shell runs the
 * user's profile, which prints banners, changes directory and takes a second to
 * do it, none of which belongs in the output of `git status`.
 */
const SHELL = process.platform === 'win32' ? 'bash.exe' : 'bash';

/** How long a killed command gets to die politely before it is killed hard. */
const GRACE_MS = 2_000;

async function execute(command: string, ctx: AgentToolContext, timeoutMs: number): Promise<Run> {
  return new Promise<Run>((resolve, reject) => {
    const started = Date.now();
    const child = spawn(SHELL, ['-c', command], {
      cwd: ctx.cwd,
      // The main process resolved the user's real PATH at startup, so the
      // commands that work in their terminal work here.
      env: process.env,
      // Its own process group, so killing it kills what it started. A test run
      // that hangs is never the shell at the top - it is the child three levels
      // under it, and that one would survive a kill aimed at its parent.
      detached: process.platform !== 'win32',
      // Nothing can be typed in, so a command that stops to ask a question gets
      // an end of input and fails now rather than holding the turn until the
      // timeout. It is also why the description says to avoid interactive ones.
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const tape = makeTape();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // Both streams into one, in the order they arrived, the way a terminal
    // shows them: what a failing build has to say is on stderr, and reading it
    // apart from the output it interrupted loses where it happened.
    child.stdout.on('data', (chunk: string) => tape.push(chunk));
    child.stderr.on('data', (chunk: string) => tape.push(chunk));

    const state: { ending: Ending; hard: NodeJS.Timeout | null } = { ending: 'ok', hard: null };
    const stop = (ending: Ending): void => {
      state.ending = ending;
      kill(child, 'SIGTERM');
      state.hard = setTimeout(() => kill(child, 'SIGKILL'), GRACE_MS);
    };

    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = (): void => stop('stopped');
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timer);
      if (state.hard !== null) clearTimeout(state.hard);
      ctx.signal.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      cleanup();
      reject(
        'code' in err && err.code === 'ENOENT'
          ? new Error(`No shell to run it with: ${SHELL} is not installed on this machine`)
          : err
      );
    });

    child.on('close', (code, signal) => {
      cleanup();
      resolve({
        output: tape.text(),
        code,
        signal,
        ending: state.ending !== 'ok' ? state.ending : code === 0 ? 'ok' : 'failed',
        ms: Date.now() - started
      });
    });
  });
}

/** The negative pid is the process group - see `detached` above. */
function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  const { pid } = child;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-pid, signal);
  } catch {
    // Already gone, which is the outcome either way.
  }
}

/** How much of a cut output is kept from the front rather than the back. */
const HEAD_CHARS = Math.floor(BASH_MAX_OUTPUT_CHARS / 4);
const TAIL_CHARS = BASH_MAX_OUTPUT_CHARS - HEAD_CHARS;

type Tape = { push: (chunk: string) => void; text: () => string };

/**
 * The output, kept from both ends.
 *
 * A run that fails says what it was doing at the top and what went wrong at the
 * bottom, and the thousand lines between are the part nobody reads. Weighted
 * towards the end, because the end is where the error is. Keeping it as it
 * arrives rather than buffering everything also means `cat` on a huge file
 * costs the same as any other command.
 *
 * What is cut says so in the text, in the middle where the gap is: output the
 * model believes is whole is worse than output it knows is missing a piece.
 */
function makeTape(): Tape {
  const kept = { head: '', tail: '', dropped: 0 };

  return {
    push(chunk: string): void {
      let rest = chunk;
      if (kept.head.length < HEAD_CHARS) {
        const room = HEAD_CHARS - kept.head.length;
        kept.head += rest.slice(0, room);
        rest = rest.slice(room);
      }
      if (rest === '') return;

      kept.tail += rest;
      if (kept.tail.length > TAIL_CHARS) {
        kept.dropped += kept.tail.length - TAIL_CHARS;
        kept.tail = kept.tail.slice(kept.tail.length - TAIL_CHARS);
      }
    },
    text(): string {
      if (kept.dropped === 0) return kept.head + kept.tail;
      return `${kept.head}\n… ${kept.dropped.toLocaleString('en-US')} characters cut from the middle …\n${kept.tail}`;
    }
  };
}

function headline(run: Run, timeoutMs: number): string {
  const took = `${(run.ms / 1000).toFixed(1)}s`;
  switch (run.ending) {
    case 'timeout':
      return `Timed out after ${Math.round(timeoutMs / 1000)}s. It was killed, along with everything it had started, and whatever it had printed by then is below.`;
    case 'stopped':
      return 'Stopped before it finished.';
    case 'failed':
      return run.code === null
        ? `Killed by ${run.signal ?? 'a signal'} after ${took}.`
        : `Exit status ${run.code} after ${took}.`;
    case 'ok':
      return `Finished in ${took}.`;
  }
}

function summarize(run: Run): string {
  switch (run.ending) {
    case 'timeout':
      return 'timed out';
    case 'stopped':
      return 'stopped';
    case 'failed':
      return run.code === null ? 'killed' : `exit ${run.code}`;
    case 'ok': {
      const lines = splitLines(run.output).length;
      return lines === 0 ? 'no output' : `${lines} line${lines === 1 ? '' : 's'}`;
    }
  }
}

/**
 * Programs that have a tool of their own, and the tool that does it better.
 *
 * `grep` in a shell answers with no line numbers, no ignore rules and no cap on
 * how much comes back; `cat` spends the context window on a file the model
 * wanted forty lines of. The model is told this in the system prompt and in the
 * tool's description, and weaker ones still reach for the shell out of habit -
 * so the reminder is repeated here, where it arrives attached to the call that
 * needed it. Contingent, like every other reminder in these tools: a note on
 * every result is a note every model learns to skip.
 */
const HAS_A_TOOL: Record<string, string | undefined> = {
  cat: 'read',
  head: 'read',
  tail: 'read',
  less: 'read',
  more: 'read',
  bat: 'read',
  ls: 'glob',
  find: 'glob',
  fd: 'glob',
  tree: 'glob',
  grep: 'grep',
  egrep: 'grep',
  fgrep: 'grep',
  rg: 'grep',
  ack: 'grep',
  ag: 'grep'
};

function instead(command: string): string[] {
  const pairs: string[] = [];
  for (const program of programs(command)) {
    const tool = HAS_A_TOOL[program];
    if (tool === undefined) continue;
    const pair = `${program} → ${tool}`;
    if (!pairs.includes(pair)) pairs.push(pair);
  }
  if (pairs.length === 0) return [];

  return [
    `The shell was the long way round here: ${pairs.join(', ')}. Those tools respect the ignore rules, number their lines and stop at a size worth reading - use them for looking at code, and the shell for what only a shell can do.`
  ];
}

/**
 * The program each part of a command line starts with, `a | b && c` being three.
 * Approximate on purpose: this decides whether to add a sentence of advice, so
 * a quoted `;` that fools it costs nothing.
 */
function programs(command: string): string[] {
  return command
    .split(/[|;&\n]+/)
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((word) => word !== '')
    .map((word) => word.split('/').pop() ?? word);
}
