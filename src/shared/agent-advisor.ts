import { z } from 'zod';
import type { ServerToolSpec } from './agent-server-tools';

/**
 * Asking a stronger model, mid-turn.
 *
 * The consultation case rather than the delegation one. Fleet's own subagents
 * run the same coding model in a fresh context and can touch the folder; an
 * advisor touches nothing, sees only the question, and is a model the executor
 * cannot afford to run for the whole turn. It is for the three moments where
 * that is worth paying for: before committing to an approach, when a bug is not
 * yielding, and before declaring a task done.
 *
 * OpenRouter runs it, so the stronger model never enters Fleet's own request -
 * the executor stays cheap and the expensive model is billed per consultation
 * instead of per round.
 */

export type AgentAdvisorConfig = {
  /** `false` ⇒ the tool is not in the request at all. */
  enabled: boolean;
  /**
   * The model consulted, fixed here rather than chosen per call.
   *
   * OpenRouter's precedence lets the executing model name its own advisor when
   * the tool entry does not, and falls back to the executor itself when neither
   * does - so leaving this unset means a "consultation" that may be the same
   * model asking itself, at the price of a second call. `null` therefore
   * disables the tool rather than sending it open.
   */
  model: string | null;
  /** System instructions for the advisor. `''` ⇒ none sent. */
  instructions: string;
  /**
   * Output budget for one consultation, reasoning included.
   *
   * Bounded because the advisor is chosen for being stronger, which usually
   * means slower and dearer per token, and because its answer is read by a
   * model rather than by a person: advice that runs to pages costs the turn
   * both the tokens to produce and the tokens to re-read every round after.
   */
  maxTokens: number;
};

export const DEFAULT_AGENT_ADVISOR: AgentAdvisorConfig = {
  // Off until it is chosen, like every other capability that spends money on a
  // second model without being asked each time.
  enabled: false,
  model: null,
  instructions: '',
  maxTokens: 2_000
};

/** What the settings will accept for the output budget. */
export const ADVISOR_MIN_TOKENS = 256;
export const ADVISOR_MAX_TOKENS = 32_000;

/**
 * The tool entry for one turn, or `null` when there is not one to send.
 *
 * `forward_transcript` is left at its default of `false` and stated anyway. The
 * alternative sends the whole conversation to the stronger model on every
 * consultation, which turns a question into a re-read of the transcript at the
 * dearer model's price - and Fleet's executor is better placed than OpenRouter
 * to decide which few files the question is actually about.
 *
 * No `name`. A named advisor is a second tool in the model's list, and one
 * unnamed entry is the default advisor - which is the whole feature until there
 * is a reason for two.
 */
export function advisorSpec(config: AgentAdvisorConfig): ServerToolSpec | null {
  if (!config.enabled || config.model === null) return null;
  return {
    type: 'openrouter:advisor',
    parameters: {
      model: config.model,
      forward_transcript: false,
      max_completion_tokens: config.maxTokens,
      ...(config.instructions.trim() === '' ? {} : { instructions: config.instructions.trim() })
    }
  };
}

/**
 * What one consultation came back with.
 *
 * Two shapes, and the failure one matters more than it looks: an advisor that
 * could not be reached returns `status: 'error'` as an ordinary tool result and
 * the turn carries on without the advice. Nothing here should turn that into an
 * exception - a consultation that failed is a turn that got no second opinion,
 * not a turn that failed.
 */
export type AdvisorResult =
  | { status: 'ok'; model: string | null; advice: string }
  | { status: 'error'; error: string };

/**
 * The advice inside a result payload, or `null` when it is not one.
 *
 * Parsed rather than typed, because this is the model's own JSON coming back
 * through a beta API. A payload that does not fit is shown as raw text instead,
 * which is the row's fallback anyway.
 */
export function parseAdvisorResult(result: string): AdvisorResult | null {
  let json: unknown;
  try {
    json = JSON.parse(result);
  } catch {
    return null;
  }
  const parsed = advisorResultSchema.safeParse(json);
  if (!parsed.success) return null;
  if (parsed.data.status === 'ok' && typeof parsed.data.advice === 'string') {
    return { status: 'ok', model: parsed.data.model ?? null, advice: parsed.data.advice };
  }
  if (parsed.data.status === 'error') {
    return { status: 'error', error: parsed.data.error ?? 'The advisor did not answer.' };
  }
  return null;
}

const advisorResultSchema = z.object({
  status: z.string(),
  model: z.string().nullish(),
  advice: z.string().nullish(),
  error: z.string().nullish()
});

/** The question that was asked, out of the call's arguments. */
export function parseAdvisorPrompt(args: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(args);
  } catch {
    return null;
  }
  const parsed = z.object({ prompt: z.string().nullish() }).safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.prompt !== null &&
    parsed.data.prompt !== undefined &&
    parsed.data.prompt !== ''
    ? parsed.data.prompt
    : null;
}

/**
 * What the model is told about the advisor it has been given.
 *
 * Added to the system prompt only when the advisor is on. The tool's own
 * description already says what it is; what it cannot say is what this
 * particular advisor is for, or that the question has to carry its own context
 * because the advisor cannot see the folder, the transcript, or anything the
 * executor has read.
 */
export const AGENT_ADVISOR_INSTRUCTIONS = [
  '## Advisor',
  '',
  'You can consult a stronger model. Use it at the three points where a second opinion is worth its price: before committing to an approach, when a bug has resisted two attempts, and before you call a hard task done.',
  'Do not consult it for something you can settle by reading a file.',
  'The advisor sees only what you write in the prompt. It cannot read this folder, this conversation, or anything you have read - so put the code, the error, and the constraint in the question itself.',
  'Ask one specific question. "Which of these two schemas survives a rename" gets an answer; "any thoughts?" gets an essay.',
  'The advice is advice. You are the one who has read the code, so say when you are overruling it and why.'
].join('\n');
