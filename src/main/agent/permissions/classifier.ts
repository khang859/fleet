import type { completeOnce, AgentWireMessage } from '../openrouter';
import type { AgentTurnUsage, AgentUsage } from '../../../shared/agent-types';
import { createLogger } from '../../logger';

const log = createLogger('agent:classifier');

/**
 * Asking a model whether a shell command is safe enough to run unasked.
 *
 * What it is not: a security boundary. Everything that could be decided by
 * reading the command line has already been decided before this is reached -
 * the user's own deny rules, and the always-ask list, which are code and are
 * never put to a vote. A model that got this wrong in the worst way would be
 * approving something that had already cleared `sudo`, credential paths, pipes
 * into shells, writes outside the folder and destructive git. What is left is
 * the grey middle - `npm install`, `curl`, `docker compose up`, `git commit` -
 * where the honest answer is a judgement rather than a pattern, and where a
 * user in a long session is otherwise answering the same question all day.
 *
 * So it can only ever remove a question. `safe` runs the command; every other
 * answer, and every failure, asks the user - which is exactly what would have
 * happened without it. That makes the failure mode of this whole file "the
 * feature did nothing", which is the direction to be wrong in.
 *
 * Its own module rather than a method on the gate, for the reason `session-
 * title` is one: no streaming, no tools, no rounds, nothing to persist. One
 * short completion whose answer is a single word.
 */

const SYSTEM_PROMPT = [
  'You decide whether one shell command may run on a developer machine without stopping to ask the person who is supervising the agent.',
  '',
  'Answer with one word: safe, or ask.',
  '',
  'Answer safe only when the command inspects or builds, and anything it changes is inside the working folder and easy to undo: reading files, searching, running a test suite, a build, a type check, a linter, a formatter, `git status`, `git diff`, `git log`, `git branch`.',
  '',
  'Answer ask for everything else, and whenever you are unsure. In particular: installing, updating or removing software; anything that reaches the network or sends data anywhere; publishing, deploying, or changing what is on a remote; deleting files; changing anything outside the working folder; starting something long-lived that nobody is watching; and anything whose effect cannot be told from the line itself.',
  '',
  'The two mistakes do not cost the same. Wrongly answering safe runs something the person would have wanted to see first. Wrongly answering ask costs them one keypress. When the command is not plainly in the first list, answer ask.'
].join('\n');

/** What the gate does with the answer. There is no third thing to do. */
export type ClassifierVerdict = 'safe' | 'ask';

/**
 * A model's answer, reduced to the one word it was asked for.
 *
 * Anything but a plain `safe` is `ask`, so this cannot fail open: an empty
 * answer, a refusal, a paragraph of reasoning, a word in another language and a
 * model that ignored the format all land on the same side. Small models still
 * wrap a one-word answer in backticks, quotes or a full stop, whatever the
 * prompt said, so that much is taken off first - the same courtesy
 * `sanitizeTitle` extends next door.
 */
export function readVerdict(raw: string): ClassifierVerdict {
  const first = raw.trim().toLowerCase().split(/\s+/)[0] ?? '';
  return first.replace(/[^a-z]/g, '') === 'safe' ? 'safe' : 'ask';
}

export type ClassifyInput = {
  apiKey: string;
  model: string;
  /** The command as it will run, whole. A line is judged the way it is typed. */
  command: string;
  /** Where it will run, which is most of what "outside the folder" means. */
  cwd: string;
  signal?: AbortSignal;
};

/** The command, with the one fact about it that is not on the line. */
export function toClassifyMessages(input: ClassifyInput): AgentWireMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Working folder: ${input.cwd}\n\nCommand:\n${input.command}` }
  ];
}

/**
 * The verdict, and what asking for it cost.
 *
 * The cost is reported even when the verdict is `ask`, and even when the answer
 * was unusable: a model that was asked was billed for answering, and a total
 * that quietly drops the calls that did not help is a total that flatters us.
 */
export type Classification = { verdict: ClassifierVerdict; usage: AgentTurnUsage | null };

/** Enough for the word, and not enough for an essay about it. */
const MAX_TOKENS = 8;

/**
 * Never throws. A classifier that is down, rate-limited, or pointed at a model
 * that no longer exists is a classifier that is not there, and the agent
 * without one asks the user - so there is nothing here for a caller to handle
 * that it would not already be doing.
 */
export async function classifyCommand(
  complete: typeof completeOnce,
  input: ClassifyInput
): Promise<Classification> {
  try {
    const answer = await complete({
      apiKey: input.apiKey,
      model: input.model,
      messages: toClassifyMessages(input),
      maxTokens: MAX_TOKENS,
      // Not the model's own default: the same command twice in one session
      // getting two different answers would read as a bug rather than as a
      // judgement, and there is nothing here that sampling could improve.
      temperature: 0,
      signal: input.signal
    });
    return { verdict: readVerdict(answer.text), usage: toTurnUsage(answer.usage, input.model) };
  } catch (err) {
    // Logged rather than raised, and not shown: the user sees the question they
    // would have seen anyway, and a card explaining that the thing that was
    // meant to save them a click failed to is worse than the click.
    log.warn('classifier failed', { model: input.model, error: String(err) });
    return { verdict: 'ask', usage: null };
  }
}

/** One un-streamed call, in the shape a session's total adds up. */
function toTurnUsage(usage: AgentUsage | null, model: string): AgentTurnUsage | null {
  if (usage === null) return null;
  return {
    billed: usage,
    // Its prompt is one command line, not the transcript, so it says nothing
    // about how full the window is. The turn's own figure stands.
    contextTokens: null,
    calls: 1,
    model,
    provider: null
  };
}
