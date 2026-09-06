import { z } from 'zod';
import type { ServerToolSpec } from './agent-server-tools';

/**
 * A panel of models reviewing one change, as OpenRouter runs it.
 *
 * `openrouter:fusion` sends the same prompt to up to eight models at once and
 * then has a ninth reconcile the answers: what they all said, what they
 * disagreed about, what only one of them noticed, what none of them looked at.
 * It is the one thing a single model cannot do for itself, because the value is
 * in the disagreement and a model has none with itself.
 *
 * It is not in the ambient tool list and it is not a setting that can put it
 * there. Nine calls fire on every use, each of them a whole model reading a
 * whole diff, so a tool left switched on is a bill that arrives whenever the
 * model decides a question feels hard. Fleet arms it for exactly the turn the
 * user asked for it on - the `/fusion` command - and for no other.
 *
 * The panel cannot see this checkout. It has web search and fetch on
 * OpenRouter's side and nothing else, so whatever it is meant to review has to
 * travel in the prompt: the diff, the files that give it meaning, and the
 * project's own constraints. That is what `AGENT_FUSION_INSTRUCTIONS` is for.
 */

/** The wire name. Also what the row and the arming check match on. */
export const FUSION_TOOL_NAME = 'openrouter:fusion';

/** The command that arms it. A turn is offered fusion when its message is this. */
export const FUSION_COMMAND_NAME = 'fusion';

export type AgentFusionConfig = {
  /**
   * The panel, by model id. Empty ⇒ OpenRouter's own quality preset.
   *
   * Empty is the default rather than a list of Fleet's choosing. The preset is
   * three current frontier models and OpenRouter moves it as the frontier
   * moves; a list written here is a list that ages, silently, into a panel of
   * last year's models.
   */
  models: string[];
  /**
   * Who reconciles the panel. `null` ⇒ the model running the turn.
   *
   * Falling back to the executor is OpenRouter's behaviour and is a reasonable
   * one here, unlike with the advisor: the analyst is not being asked for a
   * second opinion, it is being asked to summarise five of them.
   */
  analyst: string | null;
  /** Tokens for one inner call - each panel model, and the analyst. */
  maxTokens: number;
  /**
   * Web searches and fetches one inner call may make.
   *
   * An inner budget, separate from the request's own. It bounds what a single
   * panel model does while forming its opinion, and it is multiplied by the
   * size of the panel.
   */
  maxToolCalls: number;
};

export const DEFAULT_AGENT_FUSION: AgentFusionConfig = {
  models: [],
  analyst: null,
  maxTokens: 16_000,
  maxToolCalls: 4
};

/** OpenRouter's own limits, not Fleet's. */
export const FUSION_MAX_PANEL = 8;
export const FUSION_MIN_TOKENS = 1_000;
export const FUSION_MAX_TOKENS = 64_000;
export const FUSION_MIN_TOOL_CALLS = 1;
export const FUSION_MAX_TOOL_CALLS = 16;

/**
 * The tool entry for a review turn.
 *
 * Never `null`, unlike the search and advisor specs, because nothing here is a
 * toggle: the caller has already decided by arming the turn. An empty panel and
 * an unset analyst are both sent as omissions so the body says what Fleet is
 * actually asking for and OpenRouter's defaults stand where Fleet has no
 * opinion.
 *
 * The panel is truncated rather than rejected. A list that has grown past eight
 * - by a settings file edited by hand, or by a limit OpenRouter tightens - would
 * otherwise fail the whole request at the one moment the user explicitly asked
 * for a review.
 */
export function fusionSpec(config: AgentFusionConfig): ServerToolSpec {
  const models = config.models.slice(0, FUSION_MAX_PANEL);
  return {
    type: FUSION_TOOL_NAME,
    parameters: {
      ...(models.length === 0 ? {} : { analysis_models: models }),
      ...(config.analyst === null ? {} : { model: config.analyst }),
      max_completion_tokens: config.maxTokens,
      max_tool_calls: config.maxToolCalls
    }
  };
}

export type FusionStance = { model: string; stance: string };
export type FusionContradiction = { topic: string; stances: FusionStance[] };
export type FusionPartialCoverage = { models: string[]; point: string };
export type FusionInsight = { model: string; insight: string };

export type FusionAnalysis = {
  consensus: string[];
  contradictions: FusionContradiction[];
  partialCoverage: FusionPartialCoverage[];
  uniqueInsights: FusionInsight[];
  blindSpots: string[];
};

export type FusionPanelResponse = { model: string; content: string };
export type FusionFailedModel = { model: string; reason: string | null };

/**
 * What came back, in the two shapes it comes back in.
 *
 * `analysis` is nullable on a successful result and that is not an edge case.
 * The panel and the analyst are separate calls; the analyst can fail while five
 * models have already answered, and the answers are the expensive part. A
 * reader who is shown nothing in that case has paid for a review and been told
 * it did not happen.
 */
export type FusionResult =
  | {
      status: 'ok';
      analysis: FusionAnalysis | null;
      responses: FusionPanelResponse[];
      failed: FusionFailedModel[];
    }
  | {
      status: 'error';
      error: string | null;
      /**
       * OpenRouter's machine-readable cause, when it gave one. Kept as a string
       * rather than narrowed to the five documented values: this is a beta API,
       * and a sixth reason should reach the user as itself rather than be
       * dropped for failing a parse.
       */
      failureReason: string | null;
      failed: FusionFailedModel[];
    };

const stanceSchema = z.object({ model: z.string(), stance: z.string() });

const analysisSchema = z.object({
  consensus: z.array(z.string()).nullish(),
  contradictions: z
    .array(z.object({ topic: z.string(), stances: z.array(stanceSchema).nullish() }))
    .nullish(),
  partial_coverage: z
    .array(z.object({ models: z.array(z.string()).nullish(), point: z.string() }))
    .nullish(),
  unique_insights: z.array(z.object({ model: z.string(), insight: z.string() })).nullish(),
  blind_spots: z.array(z.string()).nullish()
});

const resultSchema = z.object({
  status: z.enum(['ok', 'error']),
  analysis: analysisSchema.nullish(),
  responses: z.array(z.object({ model: z.string(), content: z.string() })).nullish(),
  failed_models: z.array(z.object({ model: z.string(), reason: z.string().nullish() })).nullish(),
  error: z.string().nullish(),
  failure_reason: z.string().nullish()
});

/**
 * The result as the pane reads it, or `null` when the payload is not one.
 *
 * Every section inside the analysis is optional on the way in and total on the
 * way out, so a renderer never has to ask whether a list is there before asking
 * whether it is empty. An analysis whose every section is empty is reported as
 * no analysis at all - there is nothing to draw, and an empty five-heading
 * report reads as a bug.
 */
export function parseFusionResult(result: string): FusionResult | null {
  let json: unknown;
  try {
    json = JSON.parse(result);
  } catch {
    return null;
  }
  const parsed = resultSchema.safeParse(json);
  if (!parsed.success) return null;
  const data = parsed.data;
  const failed = (data.failed_models ?? []).map((row) => ({
    model: row.model,
    reason: row.reason ?? null
  }));

  if (data.status === 'error') {
    return {
      status: 'error',
      error: data.error ?? null,
      failureReason: data.failure_reason ?? null,
      failed
    };
  }

  const raw = data.analysis;
  const analysis: FusionAnalysis | null =
    raw === null || raw === undefined
      ? null
      : {
          consensus: raw.consensus ?? [],
          contradictions: (raw.contradictions ?? []).map((row) => ({
            topic: row.topic,
            stances: row.stances ?? []
          })),
          partialCoverage: (raw.partial_coverage ?? []).map((row) => ({
            models: row.models ?? [],
            point: row.point
          })),
          uniqueInsights: raw.unique_insights ?? [],
          blindSpots: raw.blind_spots ?? []
        };

  return {
    status: 'ok',
    analysis: analysis === null || isEmptyAnalysis(analysis) ? null : analysis,
    responses: data.responses ?? [],
    failed
  };
}

function isEmptyAnalysis(analysis: FusionAnalysis): boolean {
  return (
    analysis.consensus.length === 0 &&
    analysis.contradictions.length === 0 &&
    analysis.partialCoverage.length === 0 &&
    analysis.uniqueInsights.length === 0 &&
    analysis.blindSpots.length === 0
  );
}

/**
 * A failure reason, in English.
 *
 * The five documented causes need different things from the user - top up,
 * wait, narrow the panel - and the wire spelling says none of that. Anything
 * unrecognised is handed back as it came, so a reason added after this build
 * still reaches the person who has to act on it.
 */
export function fusionFailureMessage(reason: string | null): string {
  switch (reason) {
    case 'all_panels_failed':
      return 'Every model on the panel failed to answer.';
    case 'insufficient_credits':
      return 'Not enough OpenRouter credit for a panel this size.';
    case 'rate_limited':
      return 'OpenRouter rate-limited the panel. Try again shortly.';
    case 'fusion_invocation_capped':
      return 'This turn has already run as many reviews as it is allowed.';
    case 'unexpected_error':
      return 'OpenRouter could not complete the review.';
    case null:
      return 'The review did not complete.';
    default:
      return reason;
  }
}

/**
 * The prompt the panel is sent, as the model must be told to build it.
 *
 * Added to the system prompt only on a turn that has the tool, and it carries
 * the one fact that decides whether the review is worth anything: the panel is
 * not in this repository. Every model on it sees a single string. A prompt that
 * says "review the changes in this branch" gets eight models guessing.
 */
export const AGENT_FUSION_INSTRUCTIONS = [
  '## Panel review',
  '',
  'You have `openrouter:fusion`: a panel of models that read one prompt and answer it independently, and an analyst that reconciles them.',
  'It is offered on this turn because the user asked for a review. Call it once. Do not call it for anything else.',
  '',
  'The panel cannot see this folder, this repository, or this conversation. It sees the single prompt you write and nothing else.',
  'So gather the material first, with your own tools, and put it in the prompt:',
  '',
  '- The diff under review, in full. Read it with git rather than describing it.',
  '- The contents of the files the diff does not explain on its own - what it calls, what calls it.',
  '- The project constraints that apply: the conventions in the repository instructions, the checks that must pass, what the change is for.',
  '- The specific question, if the user asked one.',
  '',
  'A prompt that assumes the reader can look something up is a prompt eight models will guess at.',
  'When the result comes back, tell the user what it found in your own words. Lead with what the panel disagreed about and what only one model saw, because that is what a single reviewer would have missed.'
].join('\n');

/**
 * What to say when the panel was asked for and cannot be run.
 *
 * A panel runs inside OpenRouter's executor, so a turn on a local endpoint - or
 * on any target that does not carry server tools - has no way to reach one. The
 * request still has to be answered, and this is the block that answers it.
 *
 * It exists because of what happens without it. A turn whose prompt describes a
 * tool the request never sent leaves the model with an instruction it cannot
 * carry out and a user who is plainly waiting for a review, and a model in that
 * position writes one: the observed failure was a shell `echo` standing in for
 * the call, followed by "the panel has returned". Saying the panel is not
 * available is the only version of this the user can act on.
 */
export const AGENT_FUSION_UNAVAILABLE_INSTRUCTIONS = [
  '## Panel review is not available',
  '',
  'The user asked for a panel review, and this model cannot run one. Panels run inside OpenRouter, and this turn is not going through it.',
  'Say so in your first sentence. Do not simulate a panel, do not invent replies from other models, and do not report a review that did not happen.',
  'Then offer what you can actually do: review the change yourself, and say plainly that it is one reader rather than several.'
].join('\n');
