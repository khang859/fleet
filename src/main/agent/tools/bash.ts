import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_OUTPUT_CHARS,
  OUTPUT_SEPARATOR,
  type AgentToolContext,
  type AgentToolResult,
  type BashArgs
} from '../../../shared/agent-tools';
import { splitLines } from '../../../shared/agent-diff';
import { startBackgroundCommand } from './background';
import { GRACE_MS, killTree, shellError, spawnShell } from './shell';

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
 *
 * A command that is not meant to finish is handed to `background` instead, and
 * everything above still applies to it: the same permission step, the same
 * shell, the same process group. The only difference is that this file stops
 * waiting for it. See `background.ts` for what happens to it after that.
 */
export async function runBash(args: BashArgs, ctx: AgentToolContext): Promise<AgentToolResult> {
  if (!(await ctx.approve(args.command))) return REFUSED;

  // Behind the permission step, so a command the user said no to is no more
  // runnable in the background than it was in front of them.
  if (args.background === true) {
    const started = startBackgroundCommand(args.command, ctx);
    return { text: started.text, summary: started.summary };
  }

  const timeoutMs = args.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS;
  const run = await execute(args.command, ctx, timeoutMs);

  return {
    text: [
      headline(run, timeoutMs),
      ...instead(args.command),
      ...askedForATerminal(run.output),
      OUTPUT_SEPARATOR,
      run.output === '' ? 'No output.' : run.output
    ].join('\n'),
    summary: summarize(run)
  };
}

/**
 * What comes back when the user says no.
 *
 * Not an error: nothing went wrong, and a model told a call failed will try it
 * again a different way, which is the one response a refusal must not produce.
 * It is told what happened and what to do with that instead.
 */
const REFUSED: AgentToolResult = {
  text: 'The user did not allow this command to run. Do not run it another way and do not work around it - say what you were trying to do, and leave the decision with them.',
  summary: 'not allowed'
};

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

async function execute(command: string, ctx: AgentToolContext, timeoutMs: number): Promise<Run> {
  return new Promise<Run>((resolve, reject) => {
    const started = Date.now();
    const child = spawnShell(command, ctx.cwd);

    const tape = makeTape();
    // Both streams into one, in the order they arrived, the way a terminal
    // shows them: what a failing build has to say is on stderr, and reading it
    // apart from the output it interrupted loses where it happened.
    child.stdout.on('data', (chunk: string) => tape.push(chunk));
    child.stderr.on('data', (chunk: string) => tape.push(chunk));

    const state: { ending: Ending; hard: NodeJS.Timeout | null } = { ending: 'ok', hard: null };
    const stop = (ending: Ending): void => {
      state.ending = ending;
      killTree(child, 'SIGTERM');
      state.hard = setTimeout(() => killTree(child, 'SIGKILL'), GRACE_MS);
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
      reject(shellError(err));
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
 * How a command says it wanted a person.
 *
 * Closing stdin means these fail in milliseconds instead of hanging until the
 * timeout, which is the right trade - but the model is left holding an error
 * and no idea what to do with it, and the improvisation that follows is the
 * dangerous one: a password piped into `sudo -S`, a token written to a file to
 * be `cat` into a prompt. So the way out is named at the moment it is needed.
 */
const WANTED_A_TERMINAL =
  /a terminal is required|could not read (Username|Password)|Device not configured|no tty present|not a (tty|terminal)|Inappropriate ioctl for device|input device is not a TTY/i;

function askedForATerminal(output: string): string[] {
  if (!WANTED_A_TERMINAL.test(output)) return [];

  return [
    'That command wanted a terminal, and this one has nothing to type into it. Hand it to the user with the terminal tool rather than trying to answer the prompt yourself - never pipe a password into a command, and never put a secret on a command line.'
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
