import { z } from 'zod';
import type { AgentUsage } from '../../../shared/agent-types';
import { decisionInstructions } from '../../../shared/agent-classifier';
import { APP_HEADERS } from '../openrouter';
import { toTurnUsage, type Classification, type ClassifyInput } from './classifier';
import { createLogger } from '../../logger';

const log = createLogger('agent:decisions');

/**
 * The auto-approval question, put to a decision model.
 *
 * The same question `classifyCommand` asks, sent where decision models answer.
 * A decision model such as TypeSafe's Jev does not write text. It picks one of
 * the options it is given and says how sure it is. So the command goes up as
 * `state`, the two verdicts go up as the options of one `choice` question, and
 * what comes back is read as a choice rather than parsed out of a sentence.
 *
 * The rules are the ones the settings screen shows, the user's note included.
 * Only the line that tells a text model to answer in one word is left out,
 * because a decision model picks an option and writes no words.
 *
 * Everything else holds from `classifier.ts`: it can only ever remove a
 * question, it never throws, and every failure asks the user.
 */

/** OpenRouter's Decisions endpoint. Alpha, and not under `/api/v1`. */
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

/**
 * How likely `safe` has to be before a command runs unasked.
 *
 * Read from `probabilities` rather than `confidence`. TypeSafe derives
 * `confidence` from the shape of the whole distribution, which is a measure of
 * certainty, not the chance that this command is safe. The probability of
 * `safe` is the plain number this decision needs. The bar stays high, because
 * the cost of being wrong the other way is one keypress.
 */
export const MIN_SAFE_PROBABILITY = 0.9;

/**
 * Long enough for a slow alpha endpoint, short enough that a hung one does not
 * hold the agent up. When it runs out, the user is asked, as with any failure.
 */
const TIMEOUT_MS = 20_000;

/** The key both the question and the answer are filed under. */
const QUESTION = 'verdict';

/** What each option means, in the model's own terms. */
const CRITERIA = {
  safe: 'The command inspects or builds, and anything it changes is inside the working folder and easy to undo.',
  ask: 'Anything else, and whenever it is not plainly safe.'
};

const answerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()).nullish()
});

const responseSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cost: z.number().nullish()
  })
});

export type DecisionInput = Omit<ClassifyInput, 'target'>;

/** The request body, whole. Exported so the tests can check the shape. */
export function toDecisionBody(input: DecisionInput): Record<string, unknown> {
  return {
    model: input.model,
    state: { working_folder: input.cwd, command: input.command },
    questions: {
      [QUESTION]: {
        type: 'choice',
        instructions: decisionInstructions(input.note),
        criteria: CRITERIA
      }
    }
  };
}

/**
 * The verdict in one parsed answer, or `null` when there is no usable answer.
 *
 * `safe` needs both the choice and a probability of `safe` above the bar. A
 * `safe` that comes back without probabilities is `ask`: the bar cannot be
 * checked, so it is not met. Any choice other than `safe` is `ask`, so this
 * cannot fail open.
 */
export function readDecision(answer: unknown): Classification['verdict'] {
  const parsed = answerSchema.safeParse(answer);
  if (!parsed.success) return null;
  const { choice, probabilities } = parsed.data;
  if (choice !== 'safe') return 'ask';
  return (probabilities?.safe ?? 0) >= MIN_SAFE_PROBABILITY ? 'safe' : 'ask';
}

/** The Decisions usage block, in the shape every other call reports. */
function toUsage(usage: z.infer<typeof responseSchema>['usage']): AgentUsage {
  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: usage.cost ?? null,
    serverToolCalls: 0,
    webSearches: 0,
    serverToolCostUsd: null
  };
}

/** Never throws. See `classifyCommand` for why. */
export async function classifyWithDecision(
  apiKey: string,
  input: DecisionInput
): Promise<Classification> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    const res = await fetch(DECISIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...APP_HEADERS
      },
      body: JSON.stringify(toDecisionBody(input)),
      signal
    });
    if (!res.ok) {
      log.warn('decision call refused', { model: input.model, status: res.status });
      return { verdict: null, usage: null };
    }
    const parsed = responseSchema.safeParse(await res.json());
    if (!parsed.success) {
      log.warn('decision answer unreadable', { model: input.model });
      return { verdict: null, usage: null };
    }
    const verdict = readDecision(parsed.data.answers[QUESTION]);
    if (verdict === null) log.warn('decision model answered nothing', { model: input.model });
    return { verdict, usage: toTurnUsage(toUsage(parsed.data.usage), input.model) };
  } catch (err) {
    log.warn('decision call failed', { model: input.model, error: String(err) });
    return { verdict: null, usage: null };
  }
}
