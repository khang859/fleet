import {
  FALLBACK_REASONING_EFFORT,
  FALLBACK_TEMPERATURE,
  defaultThinkingBudget,
  type AgentCatalogModel,
  type AgentModelConfig
} from '../../../../../shared/agent-types';
import { Toggle } from './Toggle';
import { ModelSelect } from './ModelSelect';
import { ParamSlider, OptionPills, RoleCard } from './controls';
import { formatTokens, formatCost } from './format';

/** Sane ceiling for models whose catalog entry omits an output limit. */
const FALLBACK_OUTPUT_LIMIT = 32_000;

/**
 * Model choice plus inference settings for one agent role. Every control below
 * the picker is driven by what models.dev says the selected model supports, so
 * the panel never offers a knob the provider would reject.
 */
export function AgentRoleSettings({
  title,
  description,
  icon,
  models,
  config,
  onChange,
  allowNone = false,
  noneLabel
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  models: AgentCatalogModel[];
  config: AgentModelConfig;
  onChange: (patch: Partial<AgentModelConfig>) => void;
  allowNone?: boolean;
  noneLabel?: string;
}): React.JSX.Element {
  const model = models.find((m) => m.id === config.model) ?? null;
  const outputLimit = model?.outputLimit ?? FALLBACK_OUTPUT_LIMIT;
  const effort = model?.reasoning.find((r) => r.type === 'effort');
  const budget = model?.reasoning.find((r) => r.type === 'budget_tokens');
  const toggle = model?.reasoning.some((r) => r.type === 'toggle') ?? false;

  // Every control below falls back to what the model itself does when the
  // parameter is omitted, so an untouched setting is shown as a real number.
  const reasoningOn = config.reasoningEnabled ?? model?.defaultReasoningEnabled ?? !toggle;
  const defaultEffort =
    model?.defaultReasoningEffort ??
    (effort?.values.includes(FALLBACK_REASONING_EFFORT) === true
      ? FALLBACK_REASONING_EFFORT
      : null);
  const budgetDefault = budget
    ? Math.min(
        Math.max(defaultThinkingBudget(config.maxTokens ?? outputLimit), budget.min),
        budget.max
      )
    : 0;

  return (
    <RoleCard title={title} description={description} icon={icon}>
      <ModelSelect
        models={models}
        value={config.model}
        onChange={(id) => onChange({ model: id })}
        allowNone={allowNone}
        noneLabel={noneLabel}
      />

      {model && (
        <>
          <ModelFacts model={model} />

          <ParamSlider
            label="Max output tokens"
            hint="Left alone, a reply may run to the model's full output limit."
            value={config.maxTokens === null ? null : Math.min(config.maxTokens, outputLimit)}
            defaultValue={outputLimit}
            defaultNote="model max"
            onChange={(v) => onChange({ maxTokens: v })}
            min={1024}
            max={outputLimit}
            step={1024}
            format={formatTokens}
          />

          {model.supportsTemperature && (
            <ParamSlider
              label="Temperature"
              hint="Lower is more deterministic. Coding usually wants the low end."
              value={config.temperature}
              defaultValue={model.defaultTemperature ?? FALLBACK_TEMPERATURE}
              defaultNote={model.defaultTemperature === null ? 'provider default' : 'model default'}
              onChange={(v) => onChange({ temperature: v })}
              min={0}
              max={2}
              step={0.05}
              format={(v) => v.toFixed(2)}
            />
          )}

          {toggle && (
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <span className="text-sm text-fleet-text-secondary">Reasoning</span>
                <p className="mt-0.5 text-xs text-fleet-text-muted">
                  Let the model think before it answers.
                </p>
              </div>
              <Toggle
                checked={reasoningOn}
                onChange={(next) => onChange({ reasoningEnabled: next })}
                ariaLabel="Reasoning"
              />
            </div>
          )}

          {effort && (
            <OptionPills
              label="Reasoning effort"
              hint={
                defaultEffort === null
                  ? 'How much thinking the model budgets per turn.'
                  : `How much thinking the model budgets per turn. Default is ${defaultEffort}.`
              }
              options={effort.values}
              value={config.reasoningEffort}
              onChange={(v) => onChange({ reasoningEffort: v })}
            />
          )}

          {budget && reasoningOn && (
            <ParamSlider
              label="Thinking budget"
              hint="Tokens the model may spend reasoning before it replies."
              value={config.reasoningTokens}
              defaultValue={budgetDefault}
              defaultNote="medium effort"
              onChange={(v) => onChange({ reasoningTokens: v })}
              min={budget.min}
              max={budget.max}
              step={1024}
              format={formatTokens}
            />
          )}
        </>
      )}
    </RoleCard>
  );
}

/** The catalog's own read-only summary of the selected model. */
function ModelFacts({ model }: { model: AgentCatalogModel }): React.JSX.Element {
  const facts = [
    model.contextLimit !== null ? `${formatTokens(model.contextLimit)} context` : null,
    model.outputLimit !== null ? `${formatTokens(model.outputLimit)} max output` : null,
    // A model on the user's own hardware bills nothing, and "$0.00 / $0.00 per
    // 1M" reads as a price that failed to load rather than as an absence of one.
    model.cost && model.local === undefined ? formatCost(model.cost) : null,
    model.supportsTools ? 'Tool calling' : 'No tool calling',
    model.releaseDate ? `Released ${model.releaseDate}` : null
  ].filter((f): f is string => f !== null);

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fleet-text-muted">
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </div>
  );
}
