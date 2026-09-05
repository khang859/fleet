import { Database, Route, Shuffle } from 'lucide-react';
import {
  FALLBACK_MAX_MODELS,
  PROVIDER_SORTS,
  type AgentCacheConfig,
  type AgentFallbackConfig,
  type AgentProviderConfig,
  type ProviderSort
} from '../../../../../shared/agent-routing';
import type { AgentCatalogModel } from '../../../../../shared/agent-types';
import { RoleCard, inputCls, selectCls } from './controls';
import { Toggle } from './Toggle';
import { ModelSelect } from './ModelSelect';

/**
 * Prompt caching: paying once for the part of the request that never changes.
 *
 * The card has to be honest in a way the feature name is not. Most providers
 * cache on their own and this changes nothing for them; it is Anthropic and
 * Qwen that cache only what a request marks, and for those the marked prefix
 * comes back at a tenth of its price. So the copy says "some providers"
 * rather than promising a saving everyone will see.
 *
 * On by default, which is the one default in this group that is not today's
 * behaviour. Safe to be: a provider that does not read the marker ignores it.
 */
export function AgentCacheSettings({
  config,
  onChange
}: {
  config: AgentCacheConfig;
  onChange: (patch: Partial<AgentCacheConfig>) => void;
}): React.JSX.Element {
  return (
    <RoleCard
      title="Prompt caching"
      description="Marks the part of a request that repeats - the instructions, and the rounds already finished - so a provider can charge for it once instead of on every round. Some providers do this on their own; Anthropic and Qwen only do it when asked."
      icon={<Database size={16} />}
    >
      <Row
        id="agent-cache-enabled"
        label="Ask for a cached prefix"
        hint="Read back at about a tenth of the price on the providers that support it, and ignored by the ones that do not."
      >
        <Toggle
          id="agent-cache-enabled"
          checked={config.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
      </Row>

      {config.enabled && (
        <Row
          id="agent-cache-long-ttl"
          label="Keep it for an hour"
          hint="Five minutes otherwise. The hour costs more to write, so it pays off on a conversation you come back to rather than on one long turn."
        >
          <Toggle
            id="agent-cache-long-ttl"
            checked={config.longTtl}
            onChange={(longTtl) => onChange({ longTtl })}
          />
        </Row>
      )}
    </RoleCard>
  );
}

/**
 * Which of OpenRouter's providers may serve a request.
 *
 * One model is served by several companies at different prices, speeds and
 * levels of parameter support, and by default OpenRouter picks. This is where
 * somebody who cares says which.
 *
 * The price fields are the ones to be careful about. They bound a rate, not a
 * bill, and the hint says so in those words - "max price" reads as a cap to
 * everybody who has not read the documentation, and a user who set one
 * thinking it was a budget would find out from an invoice.
 */
export function AgentProviderSettings({
  config,
  onChange
}: {
  config: AgentProviderConfig;
  onChange: (patch: Partial<AgentProviderConfig>) => void;
}): React.JSX.Element {
  return (
    <RoleCard
      title="Provider routing"
      description="One model is served by several companies at different prices and speeds. Left alone, OpenRouter picks. Only affects OpenRouter - a server on this machine is its own provider."
      icon={<Route size={16} />}
    >
      <Row
        id="agent-routing-sort"
        label="Pick by"
        hint="Cheapest, fastest to finish, or quickest to start. Left on balanced, OpenRouter weighs price against how reliable a provider has been."
      >
        <select
          id="agent-routing-sort"
          value={config.sort}
          onChange={(e) => onChange({ sort: toSort(e.target.value) })}
          className={`${selectCls} w-36`}
        >
          {PROVIDER_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </option>
          ))}
        </select>
      </Row>

      <ListRow
        id="agent-routing-order"
        label="Try first"
        hint="Provider slugs, one per line, in the order you want them tried. Anything not listed still gets a turn after these."
        value={config.order}
        onChange={(order) => onChange({ order })}
      />

      <ListRow
        id="agent-routing-only"
        label="Only these"
        hint="A wall rather than a preference: nothing outside this list may serve the request. Leave empty for anyone."
        value={config.only}
        onChange={(only) => onChange({ only })}
      />

      <ListRow
        id="agent-routing-ignore"
        label="Never these"
        hint="Providers that must not serve the request, whatever else is set."
        value={config.ignore}
        onChange={(ignore) => onChange({ ignore })}
      />

      <Row
        id="agent-routing-require-parameters"
        label="Must support every setting"
        hint="Off, a provider that cannot honour a setting answers anyway and ignores it - a model asked to think that did not, which reads as a worse model rather than as a dropped setting."
      >
        <Toggle
          id="agent-routing-require-parameters"
          checked={config.requireParameters}
          onChange={(requireParameters) => onChange({ requireParameters })}
        />
      </Row>

      <Row
        id="agent-routing-allow-fallbacks"
        label="Fall through to anyone else"
        hint="On, the lists above are a preference. Off, they are a requirement, and a turn nobody on them can serve fails instead."
      >
        <Toggle
          id="agent-routing-allow-fallbacks"
          checked={config.allowFallbacks}
          onChange={(allowFallbacks) => onChange({ allowFallbacks })}
        />
      </Row>

      <PriceRow
        id="agent-routing-max-prompt-price"
        label="Most per million input tokens"
        value={config.maxPromptPrice}
        onChange={(maxPromptPrice) => onChange({ maxPromptPrice })}
      />

      <PriceRow
        id="agent-routing-max-completion-price"
        label="Most per million output tokens"
        value={config.maxCompletionPrice}
        onChange={(maxCompletionPrice) => onChange({ maxCompletionPrice })}
      />
    </RoleCard>
  );
}

/**
 * Models to try when the chosen one will not take the request.
 *
 * Costs nothing to have configured: OpenRouter bills only the model that
 * answered, so a fallback that never fires never appears on the invoice. And
 * one that does fire is already visible - the pane names the model that served
 * each turn - so this card does not need to announce anything.
 */
export function AgentFallbackSettings({
  models,
  config,
  onChange
}: {
  models: AgentCatalogModel[];
  config: AgentFallbackConfig;
  onChange: (patch: Partial<AgentFallbackConfig>) => void;
}): React.JSX.Element {
  const chosen = config.models.slice(0, FALLBACK_MAX_MODELS);
  return (
    <RoleCard
      title="Fallback models"
      description="Tried in order when the coding model is down or refuses the request. Only the one that answers is billed, so an unused fallback costs nothing. The pane names whichever model served each turn."
      icon={<Shuffle size={16} />}
    >
      {chosen.map((model, index) => (
        <div key={model} className="flex items-center gap-2">
          <span className="w-4 shrink-0 text-xs tabular-nums text-fleet-text-muted">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <ModelSelect
              models={models}
              value={model}
              onChange={(next) =>
                onChange({
                  models: chosen.flatMap((m, i) =>
                    i !== index ? [m] : next === null ? [] : [next]
                  )
                })
              }
              allowNone
              noneLabel="Remove"
            />
          </div>
        </div>
      ))}

      {chosen.length < FALLBACK_MAX_MODELS && (
        <ModelSelect
          models={models}
          value={null}
          onChange={(next) => {
            if (next === null || chosen.includes(next)) return;
            onChange({ models: [...chosen, next] });
          }}
          allowNone
          noneLabel={chosen.length === 0 ? 'No fallback' : 'Add another'}
        />
      )}
    </RoleCard>
  );
}

const SORT_LABELS: Record<ProviderSort, string> = {
  default: 'Balanced',
  price: 'Cheapest',
  throughput: 'Fastest',
  latency: 'Quickest to start'
};

/** A `<select>` hands back a plain string. Narrowed by lookup, never asserted. */
function toSort(value: string): ProviderSort {
  return PROVIDER_SORTS.find((sort) => sort === value) ?? 'default';
}

/** Label and hint on the left, the control on the right - the panel's own shape. */
function Row({
  id,
  label,
  hint,
  children
}: {
  id: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm text-fleet-text-secondary">
          {label}
        </label>
        <p className="mt-0.5 text-xs text-fleet-text-muted">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * A rate ceiling, and the row whose copy has to work hardest.
 *
 * It bounds what one token costs and says nothing about how many a turn will
 * spend. Calling it a budget - or letting the label imply one - would be a
 * promise Fleet cannot keep, and the user would find out from an invoice.
 */
function PriceRow({
  id,
  label,
  value,
  onChange
}: {
  id: string;
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
}): React.JSX.Element {
  return (
    <Row
      id={id}
      label={label}
      hint="A rate, not a budget: it rules out expensive providers and says nothing about what a turn will spend. Empty for no ceiling."
    >
      <div className="flex items-center gap-1">
        <span className="text-sm text-fleet-text-muted">$</span>
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          step={0.1}
          value={value ?? ''}
          placeholder="any"
          onChange={(e) => {
            const text = e.target.value.trim();
            if (text === '') {
              onChange(null);
              return;
            }
            const parsed = Number(text);
            if (!Number.isFinite(parsed) || parsed < 0) return;
            onChange(parsed);
          }}
          className={`${inputCls} w-20 tabular-nums`}
        />
      </div>
    </Row>
  );
}

/** A list of provider slugs, one per line. Same shape as the domain lists. */
function ListRow({
  id,
  label,
  hint,
  value,
  onChange
}: {
  id: string;
  label: string;
  hint: string;
  value: string[];
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm text-fleet-text-secondary">
        {label}
      </label>
      <p className="text-xs text-fleet-text-muted">{hint}</p>
      <textarea
        id={id}
        rows={2}
        value={value.join('\n')}
        placeholder="anthropic"
        onChange={(e) =>
          onChange(
            e.target.value
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== '')
          )
        }
        className={`${inputCls} resize-y font-mono text-xs`}
      />
    </div>
  );
}
