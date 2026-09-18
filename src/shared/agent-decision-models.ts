import type { AgentCatalogModel } from './agent-types';

/**
 * Models that answer a typed question instead of writing text.
 *
 * OpenRouter serves these on its Decisions endpoint, not on chat completions,
 * and leaves them out of `/api/v1/models` - so the catalog never lists them and
 * the call has to go somewhere else. Both sides need to know which ids those
 * are: the settings screen to offer them, and main to route the call.
 *
 * Only the auto-approval model can be one. It is the only setting whose answer
 * is a choice rather than prose.
 */
export const AGENT_DECISION_MODELS: AgentCatalogModel[] = [
  {
    id: 'typesafe/jev-1.13',
    name: 'TypeSafe: Jev 1.13',
    description: 'A structured decision model. Returns a typed choice with a confidence, not text.',
    contextLimit: 32_000,
    outputLimit: null,
    supportsTools: false,
    supportsTemperature: false,
    inputImage: false,
    outputImage: false,
    reasoning: [],
    cost: { input: 0.042, output: 0 },
    releaseDate: '2026-09-18',
    defaultTemperature: null,
    defaultReasoningEnabled: null,
    defaultReasoningEffort: null
  }
];

/** Whether a model id has to go to the Decisions endpoint. */
export function isDecisionModel(modelId: string | null): boolean {
  return AGENT_DECISION_MODELS.some((m) => m.id === modelId);
}
