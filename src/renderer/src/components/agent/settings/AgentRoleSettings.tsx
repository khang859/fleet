import type { AgentCatalogModel, AgentModelConfig } from '../../../../../shared/agent-types';
import { Toggle } from '../../chat/settings/Toggle';
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
            hint={`Up to ${formatTokens(outputLimit)} for this model.`}
            value={config.maxTokens === null ? null : Math.min(config.maxTokens, outputLimit)}
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
                checked={config.reasoningEnabled ?? false}
                onChange={(next) => onChange({ reasoningEnabled: next })}
                ariaLabel="Reasoning"
              />
            </div>
          )}

          {effort && (
            <OptionPills
              label="Reasoning effort"
              hint="How much thinking the model budgets per turn."
              options={effort.values}
              value={config.reasoningEffort}
              onChange={(v) => onChange({ reasoningEffort: v })}
            />
          )}

          {budget && (config.reasoningEnabled ?? !toggle) && (
            <ParamSlider
              label="Thinking budget"
              hint="Tokens the model may spend reasoning before it replies."
              value={config.reasoningTokens}
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
    model.cost ? formatCost(model.cost) : null,
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
