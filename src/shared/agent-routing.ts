/**
 * Where a request is allowed to go, what to try when the first choice will not
 * take it, and where to ask for a cached prefix.
 *
 * Three unrelated controls in one file because they are one decision in the
 * user's head - "how should this request be sent" - and because all three are
 * OpenRouter's alone. A local `llama-server` is the provider, has no fallbacks
 * and caches whatever it caches; every field here is dropped for a target that
 * is not OpenRouter, at the one place that builds the body.
 *
 * Every default is today's behaviour stated as data. `providerBody` and
 * `modelsBody` both return `null` for the defaults, so a request that changes
 * nothing sends nothing new, and the body is byte-identical to the one Fleet
 * has always sent.
 */

/** How OpenRouter picks between the providers that serve one model. */
export const PROVIDER_SORTS = ['default', 'price', 'throughput', 'latency'] as const;
export type ProviderSort = (typeof PROVIDER_SORTS)[number];

/**
 * What a request may say about which provider serves it.
 *
 * `order` and `only` overlap and are not the same thing: `order` is a
 * preference that still falls through to the rest, `only` is a wall. Both are
 * offered because the difference is the whole question a user is asking - "I
 * would rather have Together" against "this must not leave Together".
 */
export type AgentProviderConfig = {
  /** Providers to try first, in this order. Everything else follows. */
  order: string[];
  /** When set, nothing outside this list may serve the request. */
  only: string[];
  /** Providers that must never serve the request. */
  ignore: string[];
  /** How to pick among whatever is left. `default` sends nothing. */
  sort: ProviderSort;
  /**
   * Whether a provider that cannot honour every parameter may still serve.
   *
   * Off matches OpenRouter's own default, and the failure it allows is quiet:
   * a provider that ignores `reasoning` answers without thinking rather than
   * refusing, and the answer looks like a worse model rather than a dropped
   * parameter.
   */
  requireParameters: boolean;
  /**
   * Whether OpenRouter may fall through to a provider outside the preferences.
   *
   * On by default, which is OpenRouter's default too. Off turns a preference
   * into a requirement, and a turn that cannot meet it fails rather than being
   * served by somebody else.
   */
  allowFallbacks: boolean;
  /**
   * Dollars per million tokens a provider may charge, or `null` for no ceiling.
   *
   * A rate, and never a budget. It bounds what one token costs and says
   * nothing at all about how many tokens a turn will spend, so a cheap rate on
   * a long turn is still a long turn's bill. The copy in the settings pane has
   * to say so, because "max price" reads like a cap to everyone who has not
   * read this.
   */
  maxPromptPrice: number | null;
  maxCompletionPrice: number | null;
};

export const DEFAULT_AGENT_PROVIDER: AgentProviderConfig = {
  order: [],
  only: [],
  ignore: [],
  sort: 'default',
  requireParameters: false,
  allowFallbacks: true,
  maxPromptPrice: null,
  maxCompletionPrice: null
};

/**
 * The `provider` field of a request, or `null` when there is nothing to say.
 *
 * `null` rather than an empty object, so an untouched configuration sends no
 * field at all. An empty `provider: {}` would be harmless today and is exactly
 * the kind of thing that stops being harmless when a default changes at the
 * other end.
 *
 * `allow_fallbacks` is sent only when it is false, because true is what
 * OpenRouter does already and restating a default is one more number to keep
 * in step with theirs.
 */
export function providerBody(config: AgentProviderConfig): Record<string, unknown> | null {
  const price = {
    ...(config.maxPromptPrice === null ? {} : { prompt: config.maxPromptPrice }),
    ...(config.maxCompletionPrice === null ? {} : { completion: config.maxCompletionPrice })
  };
  const body = {
    ...(config.order.length === 0 ? {} : { order: config.order }),
    ...(config.only.length === 0 ? {} : { only: config.only }),
    ...(config.ignore.length === 0 ? {} : { ignore: config.ignore }),
    ...(config.sort === 'default' ? {} : { sort: config.sort }),
    ...(config.requireParameters ? { require_parameters: true } : {}),
    ...(config.allowFallbacks ? {} : { allow_fallbacks: false }),
    ...(Object.keys(price).length === 0 ? {} : { max_price: price })
  };
  return Object.keys(body).length === 0 ? null : body;
}

/**
 * Models to try when the chosen one will not take the request.
 *
 * A plain ordered list. OpenRouter takes the primary model in `model` and the
 * whole list in `models`, tries them in order, and bills only the one that
 * answered - so a fallback that never fires costs nothing to have configured.
 *
 * Which one answered is already on screen: `StreamOutcome.model` carries the
 * served model and the pane shows it. So a fallback that fires is visible
 * without anything here having to announce it.
 */
export type AgentFallbackConfig = {
  /** Tried in order after the chosen model. Empty means no fallback. */
  models: string[];
};

export const DEFAULT_AGENT_FALLBACK: AgentFallbackConfig = { models: [] };

/** How many a user may line up. Past this the wait to fail is longer than the turn. */
export const FALLBACK_MAX_MODELS = 4;

/**
 * The `models` field, or `null` when there is nothing to fall back to.
 *
 * The primary goes first because OpenRouter reads the list as the whole route
 * rather than as the alternatives: a list that omitted the chosen model would
 * quietly replace it. Duplicates are dropped for the same reason - a model
 * named twice would be tried twice before moving on.
 */
export function modelsBody(config: AgentFallbackConfig, primary: string): string[] | null {
  if (config.models.length === 0) return null;
  const seen = new Set<string>();
  const route = [primary, ...config.models.slice(0, FALLBACK_MAX_MODELS)].filter((model) => {
    if (model === '' || seen.has(model)) return false;
    seen.add(model);
    return true;
  });
  return route.length < 2 ? null : route;
}

/**
 * Whether to ask for a cached prefix, and how long it should live.
 *
 * The honest framing, which the settings copy has to keep: most providers
 * cache on their own and this changes nothing for them. It is Anthropic and
 * Qwen that cache only where a request marks a breakpoint, and for those the
 * marked prefix is read back at a tenth of its price.
 *
 * On by default, and that is the one default here that is not today's
 * behaviour. It is safe to be: a provider that does not read the marker
 * ignores it, so the worst case is a field nobody looks at, and the best case
 * is the system prompt and the finished rounds of a long turn costing a tenth
 * of what they cost now.
 */
export type AgentCacheConfig = {
  enabled: boolean;
  /**
   * Whether to ask Anthropic for the hour-long cache rather than five minutes.
   *
   * Off by default because the trade goes the wrong way for most turns: the
   * hour costs 2x to write against 1.25x, and a prefix that is not read again
   * within the five minutes is usually not read again at all. It earns its
   * keep on a conversation somebody comes back to after lunch.
   */
  longTtl: boolean;
};

export const DEFAULT_AGENT_CACHE: AgentCacheConfig = { enabled: true, longTtl: false };

/**
 * The marker a message part carries to say "cache everything up to here".
 *
 * Returned as an object to spread rather than as a value, so a caller that has
 * caching off spreads nothing and the part is byte-identical to what it was.
 */
export function cacheControl(config: AgentCacheConfig): Record<string, unknown> {
  if (!config.enabled) return {};
  return { cache_control: { type: 'ephemeral', ...(config.longTtl ? { ttl: '1h' } : {}) } };
}
