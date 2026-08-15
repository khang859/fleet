import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import type { Readable } from 'node:stream';

/**
 * Starting and stopping a shell, for the two tools that do it.
 *
 * `bash` runs a command and waits for it; `background` runs one and does not.
 * How the process is started is the same question for both - the same shell,
 * the same process group, the same claim on the machine - and getting it right
 * is what makes a hung command killable at all, so it lives in one place rather
 * than being written twice and drifting.
 */

/**
 * The shell. Non-login and non-interactive on purpose: a login shell runs the
 * user's profile, which prints banners, changes directory and takes a second to
 * do it, none of which belongs in the output of `git status`.
 */
export const SHELL = process.platform === 'win32' ? 'bash.exe' : 'bash';

/** How long a killed command gets to die politely before it is killed hard. */
export const GRACE_MS = 2_000;

/** The error a missing shell deserves, said in words the model can act on. */
export function shellError(err: Error): Error {
  return 'code' in err && err.code === 'ENOENT'
    ? new Error(`No shell to run it with: ${SHELL} is not installed on this machine`)
    : err;
}

/** What `spawnShell` hands back: no stdin, and both output streams piped. */
export type ShellProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * A command, started but not waited on.
 *
 * Both streams are piped and left for the caller to drain, because what to do
 * with the output is the only part of this the two tools disagree about.
 */
export function spawnShell(command: string, cwd: string): ShellProcess {
  const child = spawn(SHELL, ['-c', command], {
    cwd,
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

  standAside(child);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return child;
}

/**
 * Let the app have the processor ahead of the command.
 *
 * A test run or a build saturates every core it is given, and several agents
 * doing it at once will happily take the machine. What loses that fight is
 * Fleet itself - the main process that has to flush a terminal every sixteen
 * milliseconds, and the renderer that has to draw the character the user just
 * typed - and the user experiences it as the app going soft while an agent
 * works, which is the thing this must not do.
 *
 * A lower priority rather than a queue, deliberately. Queueing commands would
 * mean one pane's ten-minute test run holding up another pane's `git status`,
 * which is the same complaint in a new place. This costs the command nothing
 * on an idle machine and only yields when there is something else to run - and
 * the nice value is inherited, so what the shell starts is covered too.
 *
 * Best-effort: a platform that will not have it is not a reason to fail the
 * command, which is why nothing here is reported.
 */
function standAside(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Not permitted, or the command was over before we got to it.
  }
}

/** The negative pid is the process group - see `detached` above. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const { pid } = child;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-pid, signal);
  } catch {
    // Already gone, which is the outcome either way.
  }
}

/** Ask it to stop, and insist a couple of seconds later. */
export function stopTree(child: ChildProcess): NodeJS.Timeout {
  killTree(child, 'SIGTERM');
  return setTimeout(() => killTree(child, 'SIGKILL'), GRACE_MS);
}
