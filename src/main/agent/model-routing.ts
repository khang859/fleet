import type { LocalEndpointConfig } from '../../shared/agent-endpoints';
import { endpointLabel } from '../../shared/agent-endpoints';
import { hostPort } from '../../shared/agent-endpoint-url';
import { parseModelId } from '../../shared/agent-model-id';
import type { CompletionsTarget } from './completions';
import { openRouterTarget } from './openrouter';

/**
 * Turning "the model the user picked" into "the call to make".
 *
 * Every path that reaches a model - a turn, a subagent, a compaction, naming a
 * session, judging a command in auto mode, summarising a pane - passes through
 * here first, and none of them branch on the answer. That is the point: the
 * question "is this local?" is asked exactly once, in one function, and what
 * comes back is already a place to send bytes to.
 */

export type ResolvedTarget =
  | { ok: true; target: CompletionsTarget; wireModelId: string }
  | { ok: false; reason: ResolveFailure; message: string };

export type ResolveFailure =
  | 'no-model'
  | 'no-key'
  /** The id names an endpoint the user has since deleted. */
  | 'endpoint-missing'
  | 'endpoint-disabled';

export type RoutingDeps = {
  getOpenRouterKey: () => string | null;
  getEndpoints: () => LocalEndpointConfig[];
};

/**
 * Where to send a call for one model, or why there is nowhere to send it.
 *
 * Failures come back as data rather than as a throw because all four of them
 * are ordinary states of a half-configured app rather than bugs, and each wants
 * its own sentence on screen. The caller turns whichever it gets into a stream
 * error, which is the same path a rejected key has always taken.
 */
export function resolveTarget(modelId: string | null, deps: RoutingDeps): ResolvedTarget {
  if (modelId === null) return { ok: false, reason: 'no-model', message: 'No model selected.' };

  const parsed = parseModelId(modelId);
  if (parsed.kind === 'openrouter') {
    const apiKey = deps.getOpenRouterKey();
    if (apiKey === null || apiKey === '') {
      return {
        ok: false,
        reason: 'no-key',
        message: `“${modelId}” is an OpenRouter model and no API key is set. Add one in Agent settings, or choose a local model.`
      };
    }
    return { ok: true, target: openRouterTarget(apiKey), wireModelId: modelId };
  }

  const endpoint = deps.getEndpoints().find((e) => e.id === parsed.endpointId);
  if (endpoint === undefined) {
    return {
      ok: false,
      reason: 'endpoint-missing',
      message: `The local server this model was on is no longer set up. Choose another model in Agent settings.`
    };
  }
  const label = endpointLabel(endpoint, hostPort(endpoint.baseUrl));
  if (!endpoint.enabled) {
    return {
      ok: false,
      reason: 'endpoint-disabled',
      message: `${label} is switched off. Turn it back on in Agent settings, or choose another model.`
    };
  }

  return {
    ok: true,
    wireModelId: parsed.wireId,
    target: {
      baseUrl: `${endpoint.baseUrl}/v1`,
      // Local servers are started without `--api-key` far more often than with
      // one, and there is no field to type one into: an endpoint that wants
      // credentials is reported as such by the probe rather than guessed at.
      apiKey: null,
      extraHeaders: {},
      requestUsage: true,
      reasoningDialect: 'chat-template-kwargs',
      label
    }
  };
}
