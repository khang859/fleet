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
 * A decision model such as TypeSafe's Jev does not write text. It answers a
 * typed question with a number. So the developer's request, the folder and the
 * command go up as `state` in plain words, "may this run unasked?" goes up as
 * one yes-or-no (`noul`) question, and what comes back is the chance of yes.
 *
 * The rules are `decisionInstructions`, the user's note included. They differ
 * from the text model's on purpose - see `agent-classifier`.
 *
 * Everything else holds from `classifier.ts`: it can only ever remove a
 * question, it never throws, and every failure asks the user.
 */

/** OpenRouter's Decisions endpoint. Alpha, and not under `/api/v1`. */
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

/**
 * How likely "yes" has to be before a command runs unasked.
 *
 * Measured, not guessed: on 180 commands from real sessions and 22 destructive
 * ones, every destructive command scored 0.15 or less, and 0.7 asked about 3 of
 * the 180. Higher asks about ordinary work for no gain; the gap below is wide.
 */
export const MIN_SAFE_PROBABILITY = 0.7;

/**
 * Long enough for a slow alpha endpoint, short enough that a hung one does not
 * hold the agent up. When it runs out, the user is asked, as with any failure.
 */
const TIMEOUT_MS = 20_000;

/**
 * The most of the developer's request that is sent. A `/command` or a pasted
 * log can be long, and the start of a request is where it says what it wants.
 */
const MAX_REQUEST_CHARS = 2_000;

/** The key both the question and the answer are filed under. */
const QUESTION = 'safe_to_run';

/** What yes and no mean, in the model's own terms. */
const CRITERIA = {
  true: 'Low-impact or easy to undo, and in line with what the developer asked.',
  false: 'Could lose work, reaches other people, or goes beyond what the developer asked.'
};

const answerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number()
});

const responseSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cost: z.number().nullish()
  })
});

export type DecisionInput = Omit<ClassifyInput, 'target'> & {
  /**
   * What the developer last asked the agent for, or `null` when there is no
   * such thing - a subagent, whose task was written by another model. Without
   * it the command is judged alone, so anything that posts or pushes is asked.
   */
  request: string | null;
};

/** What the model is shown: the request, then where, then the command. */
function toState(input: DecisionInput): string {
  const request = input.request?.trim() ?? '';
  return [
    `The developer asked the agent:\n${request === '' ? '(not known)' : request.slice(0, MAX_REQUEST_CHARS)}`,
    `Working folder: ${input.cwd}`,
    `Proposed shell command:\n${input.command}`
  ].join('\n\n');
}

/** The request body, whole. Exported so the tests can check the shape. */
export function toDecisionBody(input: DecisionInput): Record<string, unknown> {
  return {
    model: input.model,
    state: toState(input),
    questions: {
      [QUESTION]: {
        type: 'noul',
        instructions: decisionInstructions(input.note),
        criteria: CRITERIA
      }
    }
  };
}

/**
 * The verdict in one parsed answer, or `null` when there is no usable answer.
 *
 * `safe` needs the chance of yes at or above the bar; anything below is `ask`,
 * so this cannot fail open.
 */
export function readDecision(answer: unknown): Classification['verdict'] {
  const parsed = answerSchema.safeParse(answer);
  if (!parsed.success) return null;
  return parsed.data.noul >= MIN_SAFE_PROBABILITY ? 'safe' : 'ask';
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
