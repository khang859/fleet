/**
 * What the agent is told about the machine it is running on, and when.
 *
 * A model knows nothing about the computer in front of it. Left untold, it
 * writes `sed -i ''` on Linux, suggests `brew` on Windows, and answers "what
 * changed this week?" from a training cutoff that is months stale. Every
 * harness worth copying tells it: Claude Code, Codex and opencode all send the
 * working folder, the platform, the shell and the date, having each arrived
 * there separately.
 *
 * Where they differ is what this file is really about. The facts split in two,
 * and the split is not cosmetic:
 *
 * - The machine does not change while a conversation runs. Platform, shell and
 *   timezone belong in the system message, which is the request's cache prefix,
 *   and being stable is what lets that prefix stay cached.
 * - The clock changes on every turn. Putting it in the same message would
 *   rewrite the prefix each round and throw the cache away with it - a forty
 *   round turn paying full rate forty times over - and it would still be wrong,
 *   because a system prompt is built once and a session can run for hours.
 *
 * So the clock rides at the tail instead, immediately before the newest user
 * message. Everything after that point is being re-sent uncached anyway, which
 * makes the fresher answer also the free one. Codex reached the same shape from
 * the other direction, and Claude Code sends its date as a reminder on the user
 * turn rather than in its environment block.
 *
 * Pure, and in `shared`, for the reason `agent-context.ts` gives about itself:
 * main reads the machine, this decides what the bytes say. It also has to be -
 * the settings pane imports `agent-types`, so a `node:os` import anywhere on
 * that path would follow it into the renderer bundle.
 */

/** What Fleet knows about the machine, none of which changes mid-conversation. */
export type AgentEnvironment = {
  /** `process.platform`: `darwin`, `linux`, `win32`. */
  platform: string;
  /** Kernel name and version, e.g. `Darwin 25.5.0`. */
  osVersion: string;
  /** The shell a `terminal` command would be typed into. */
  shell: string;
  isGitRepo: boolean;
  /** IANA zone name, e.g. `Asia/Ho_Chi_Minh`. The offset is not here: it moves with the clock. */
  timeZone: string;
  /** OpenRouter model id serving this turn, e.g. `anthropic/claude-sonnet-4.5`. */
  model: string;
};

/**
 * The static half, for the end of the system prompt.
 *
 * Framed in prose and indented rather than wrapped in a tag, which is the house
 * style for every block Fleet assembles - see `renderTodoBlock` and
 * `renderProjectInstructions`, and `FLEET_WIRE_PREFIX` for the reasoning behind
 * it. A turn here can be answered by whichever model OpenRouter routes it to,
 * and a tag one of them has never seen is either ignored or read out loud.
 *
 * The working folder is a parameter rather than a field because it is the one
 * fact Fleet has always sent, from before there was a block to put it in, and
 * it is the caller's own `cwd` rather than something read off the machine.
 */
export function renderEnvBlock(cwd: string, env: AgentEnvironment): string {
  return [
    'Here is what Fleet knows about the machine you are running on:',
    '',
    `  Working folder: ${cwd}`,
    `  Is a git repo: ${env.isGitRepo ? 'yes' : 'no'}`,
    `  Platform: ${env.platform}`,
    `  OS version: ${env.osVersion}`,
    `  Shell: ${env.shell}`,
    `  Timezone: ${env.timeZone}`,
    `  Model: ${env.model}`
  ].join('\n');
}

/**
 * The clock, as the user's own wall reads it.
 *
 * Local rather than UTC because every question the time is asked in service of
 * - whether a log line is from today, how long a build has been running, what
 * "yesterday" means in a commit range - is asked about the clock the developer
 * is looking at. The offset comes along so the reading is still unambiguous,
 * and it is computed per call rather than stored on the environment because it
 * is not a property of the machine: the same zone is `+01:00` in January and
 * `+02:00` in July.
 */
export function formatLocalTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    // `h23` rather than `hour12: false`, which renders midnight as hour 24.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset'
  }).formatToParts(date);

  const at = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return (
    `${at('year')}-${at('month')}-${at('day')} ` +
    `${at('hour')}:${at('minute')}:${at('second')} ${offsetOf(at('timeZoneName'))}`
  );
}

/**
 * `+07:00` from the `GMT+07:00` the formatter writes.
 *
 * UTC is the case worth naming: it formats as a bare `GMT`, which would leave
 * nothing behind, so it is spelled out as the zero offset it is.
 */
function offsetOf(timeZoneName: string): string {
  const offset = timeZoneName.replace('GMT', '');
  return offset === '' ? '+00:00' : offset;
}

/**
 * The volatile half, for the message before the newest one.
 *
 * The bare reading, with no note about where it came from: it goes out under
 * `FLEET_WIRE_PREFIX` like every other block Fleet pushes onto a round, so that
 * a round carrying the clock and a task list does not appear to have two
 * different things talking to the model. Adding the prefix is the caller's job
 * here for the same reason it is in `renderTodoBlock`.
 */
export function renderTimeBlock(date: Date, timeZone: string): string {
  return `Current time: ${formatLocalTime(date, timeZone)}`;
}
