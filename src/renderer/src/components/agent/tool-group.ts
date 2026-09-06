import type { AgentPart } from '../../../../shared/agent-types';
import type { AgentToolCall } from '../../../../shared/agent-tools';
import { isTodoTool } from '../../../../shared/agent-tools';
import { toolLabel } from './tool-label';

/**
 * A run of the same lookup, folded into one row.
 *
 * Answering one question takes the agent a dozen reads, and drawn one to a row
 * they are most of the transcript: half the tool rows in a real session are part
 * of a repeat run, and the longest seen is twelve reads in a row. What a reader
 * wants from those twelve is that the agent went to the right place, and that is
 * one line's worth of information rather than twelve.
 *
 * Only the lookups fold. A read that found nothing and a read that found the
 * answer look the same from outside, which is exactly why a count is enough for
 * them - and exactly why it is not enough for a change to a file, a command, or
 * a picture, where the row *is* the thing that happened and no number stands in
 * for it.
 */

/**
 * The tools whose repeats fold.
 *
 * Grouped on the name rather than on some notion of what kind of tool it is.
 * Folding `glob` and `grep` together under one word for searching is the obvious
 * next step and it buys nothing measurable: a model globs, then greps, rather
 * than alternating, so the merged runs are the same runs. A classification that
 * changes no output is a classification not worth having - and one worth
 * avoiding, since a call whose class changes underneath a rendered group is its
 * own class of bug.
 *
 * Every one of these is a call whose whole story is told when it comes back,
 * which is what makes a count of them honest. `image` is the tool that is not:
 * it has something worth watching before it is finished, and the half-drawn
 * renders arrive on a channel of their own keyed by call id. Nothing in a folded
 * run can be receiving those, which is why the group hands its rows no live
 * preview - add `image` here and that stops being true.
 */
const GROUPABLE = new Set(['read', 'glob', 'grep']);

/**
 * How many of the same call it takes before they fold.
 *
 * Three, because two is where the trade goes bad. Folding a pair saves one line
 * and costs a filename, and pairs are the most common run there is; from three
 * on, the run is long enough that the count is the more useful of the two
 * things. In practice this still folds seven eighths of everything foldable.
 */
const MIN_RUN = 3;

/** The transcript as it is drawn: parts as they came, with the runs folded. */
export type TranscriptItem =
  | { kind: 'part'; part: AgentPart; key: number }
  | { kind: 'run'; name: string; calls: AgentToolCall[]; key: number };

/**
 * The parts of one turn, with each run of repeated lookups folded into one.
 *
 * Derived on every render rather than accumulated as the calls arrive. A run
 * that grows from three to eight is the same function over a longer array, so
 * nothing has to notice that a group is still growing, and there is no second
 * copy of the transcript to disagree with the first about what happened.
 *
 * `key` is the index the run starts at. Keyed on its last member instead, every
 * arriving call would remount the group and shut it again under a reader who had
 * just opened it.
 */
export function groupParts(parts: AgentPart[], askCallId: string | null): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  /**
   * The run being gathered. `at` is where its calls came from, so a run that
   * turns out too short can be given back as the parts it was made of, and
   * `passed` is the invisible parts that fell inside it - held rather than
   * emitted, so that whichever way the run resolves, nothing is emitted out of
   * the order it happened in.
   */
  let run: { name: string; at: number[]; calls: AgentToolCall[]; passed: number[] } | null = null;

  const single = (at: number): void => {
    items.push({ kind: 'part', part: parts[at], key: at });
  };

  const flush = (): void => {
    if (run === null) return;
    const { name, at, calls, passed } = run;
    // Cleared first: `single` reads `run` through nothing, but the recursion
    // that a nested flush would be is worth ruling out by construction.
    run = null;
    if (calls.length >= MIN_RUN) {
      items.push({ kind: 'run', name, calls, key: at[0] });
      for (const i of passed) single(i);
      return;
    }
    for (const i of [...at, ...passed].sort((a, b) => a - b)) single(i);
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Drawn as nothing, so it separates nothing. A task list updated in the
    // middle of a sweep is bookkeeping the transcript already declines to show,
    // and letting it split the sweep in two would put a seam on screen where
    // the reader can see no reason for one. Worth a third of the folding.
    if (
      part.type === 'attachment' ||
      part.type === 'responses' ||
      (part.type === 'tool' && isTodoTool(part.call.name))
    ) {
      if (run === null) single(i);
      else run.passed.push(i);
      continue;
    }

    const name = groupableName(part, askCallId);
    if (name === null) {
      flush();
      single(i);
      continue;
    }
    if (run !== null && run.name !== name) flush();
    run ??= { name, at: [], calls: [], passed: [] };
    run.at.push(i);
    // Narrowed by `groupableName` having returned a name at all.
    if (part.type === 'tool') run.calls.push(part.call);
  }
  flush();
  return items;
}

/**
 * The name this part folds under, or `null` for a part that ends a run.
 *
 * The three that end one despite being ordinary calls are the three the
 * transcript already draws as something other than a row: a call the user is
 * being asked about becomes the question, a dispatched subagent becomes a card,
 * and a call that failed keeps the one line on which the reason exists. A
 * failure is the case worth being careful about - it is the row a reader most
 * needs to see, and a count is where it would go to be missed.
 */
function groupableName(part: AgentPart, askCallId: string | null): string | null {
  if (part.type !== 'tool') return null;
  if (!GROUPABLE.has(part.call.name)) return null;
  if (part.call.error !== null) return null;
  if (part.call.id === askCallId) return null;
  return part.call.name;
}

/** Whether a folded run is still going. Only its last call can be. */
export function runRunning(calls: AgentToolCall[]): boolean {
  const last = calls.at(-1);
  return last?.result === null && last.error === null;
}

/**
 * What the folded row says: the verb, then how many of the thing there were.
 *
 * Present tense while the sweep is happening and past once it is over, because
 * a row that reads "Read 5 files" beside a spinner is claiming to have finished
 * something it is in the middle of. The verbs are the ones the individual rows
 * already use, so opening a group does not change the word the reader was
 * looking at.
 */
export function runLabel(name: string, count: number, running: boolean): string {
  const noun = count === 1 ? NOUN[name] : `${NOUN[name]}s`;
  return `${(running ? RUNNING_VERB : VERB)[name]} ${count} ${noun}`;
}

const VERB: Record<string, string> = { read: 'Read', glob: 'Find', grep: 'Search' };
const RUNNING_VERB: Record<string, string> = {
  read: 'Reading',
  glob: 'Finding',
  grep: 'Searching'
};
const NOUN: Record<string, string> = { read: 'file', glob: 'pattern', grep: 'pattern' };

/** How many of a run's targets the folded row names before it gives a count. */
const PREVIEW = 2;

/**
 * The part of the row that says where it went.
 *
 * A count on its own is the one thing this row could get wrong: five filenames
 * are how a reader checks the agent looked in the right place, and trading all
 * five for the number five answers a question nobody asked. Two names and a
 * remainder keep the check and still fold the height, and the rest are one
 * click away rather than gone.
 *
 * While the run is going it names the file being read instead. Which one of
 * eight it is currently on is worth more than which two it started with, and it
 * is the only thing on the row that is still changing.
 */
export function runPreview(name: string, calls: AgentToolCall[]): string {
  if (runRunning(calls)) return target(name, calls[calls.length - 1]);
  const shown = calls.slice(0, PREVIEW).map((call) => target(name, call));
  const rest = calls.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ');
}

/**
 * One call's target, small enough to sit beside another.
 *
 * A read's target is a path, and a path is mostly the directory it is in - which
 * is the half a preview can afford to drop, since the run's rows are right there
 * with the whole of it. A pattern is already short and is left as it was.
 */
function target(name: string, call: AgentToolCall): string {
  const { target: full } = toolLabel(call);
  if (name !== 'read') return full;
  const cut = full.lastIndexOf('/');
  return cut === -1 ? full : full.slice(cut + 1);
}
