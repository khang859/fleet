import { Users, X } from 'lucide-react';
import {
  DEFAULT_AGENT_FUSION,
  FUSION_MAX_PANEL,
  FUSION_MAX_TOKENS,
  FUSION_MAX_TOOL_CALLS,
  FUSION_MIN_TOKENS,
  FUSION_MIN_TOOL_CALLS,
  type AgentFusionConfig
} from '../../../../../shared/agent-fusion';
import type { AgentCatalogModel } from '../../../../../shared/agent-types';
import { BoundedNumber, RoleCard } from './controls';
import { ModelSelect } from './ModelSelect';

/**
 * The panel `/fusion` assembles, and what it is allowed to spend doing it.
 *
 * A card with no on switch, which is the point of it. Nothing here can put the
 * tool in an ordinary turn's tool list: it is offered when the user types
 * `/fusion` and never otherwise, because a panel is one model call per member
 * plus one more to reconcile them, and a tool that costs nine calls should not
 * be reachable by a model deciding a question feels hard.
 */
export function AgentFusionSettings({
  models,
  config,
  onChange
}: {
  models: AgentCatalogModel[];
  config: AgentFusionConfig;
  onChange: (patch: Partial<AgentFusionConfig>) => void;
}): React.JSX.Element {
  const panel = config.models;
  const full = panel.length >= FUSION_MAX_PANEL;

  return (
    <RoleCard
      title="Panel review"
      description="Run /fusion in a chat to put a change in front of several models at once and have a further one reconcile them. One model call per panel member plus the analyst, billed per review."
      icon={<Users size={16} />}
    >
      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-fleet-text-secondary">Panel</label>
        <p className="text-xs text-fleet-text-muted">
          Up to {FUSION_MAX_PANEL}. Left empty, OpenRouter picks a panel of current frontier models
          and keeps that choice current - which is usually better than a list written here and left
          to age. Choose your own when you want models that disagree in particular ways.
        </p>
        {panel.length > 0 && (
          <ul className="flex flex-col gap-1">
            {panel.map((id) => (
              <li
                key={id}
                className="flex items-center justify-between gap-2 rounded-md border border-fleet-border px-2 py-1"
              >
                <span className="truncate font-mono text-xs text-fleet-text-secondary">{id}</span>
                <button
                  type="button"
                  aria-label={`Remove ${id} from the panel`}
                  onClick={() => onChange({ models: panel.filter((m) => m !== id) })}
                  className="shrink-0 text-fleet-text-subtle transition-colors hover:text-fleet-text focus-ring"
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {/*
         * A picker that never holds a value: choosing appends and it goes back
         * to reading "Add a model". A row per member with its own picker would
         * let the same model be chosen twice, which costs a slot and returns
         * one opinion.
         */}
        {!full && (
          <ModelSelect
            models={models.filter((model) => !panel.includes(model.id))}
            value={null}
            onChange={(model) => {
              if (model === null || panel.includes(model)) return;
              onChange({ models: [...panel, model] });
            }}
            placeholder={panel.length === 0 ? "Add a model, or leave OpenRouter's" : 'Add a model'}
          />
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-fleet-text-secondary">Analyst</label>
        <p className="text-xs text-fleet-text-muted">
          Reads every reply and reports the agreement, the disagreements and what only one model
          saw. Left unset it is the model running the chat, which is a fair default - this is
          summarising opinions rather than forming one.
        </p>
        <ModelSelect
          models={models}
          value={config.analyst}
          onChange={(analyst) => onChange({ analyst })}
          allowNone
          noneLabel="The model running the chat"
          placeholder="The model running the chat"
        />
      </div>

      <NumberRow
        id="agent-fusion-max-tokens"
        label="Reply length"
        hint="Tokens for one reply, thinking included. Every panel member gets this, so it multiplies."
        value={config.maxTokens}
        min={FUSION_MIN_TOKENS}
        max={FUSION_MAX_TOKENS}
        step={1_000}
        fallback={DEFAULT_AGENT_FUSION.maxTokens}
        onChange={(maxTokens) => onChange({ maxTokens })}
      />

      <NumberRow
        id="agent-fusion-max-tool-calls"
        label="Lookups per model"
        hint="Web searches and fetches one panel member may make while forming its answer. Multiplied by the size of the panel."
        value={config.maxToolCalls}
        min={FUSION_MIN_TOOL_CALLS}
        max={FUSION_MAX_TOOL_CALLS}
        step={1}
        fallback={DEFAULT_AGENT_FUSION.maxToolCalls}
        onChange={(maxToolCalls) => onChange({ maxToolCalls })}
      />
    </RoleCard>
  );
}

/**
 * A bounded number, clamped when the field is left rather than while typing.
 *
 * Clamping on every keystroke makes a field you cannot clear to retype: the
 * moment the box is empty it snaps to the minimum, and the digit typed next
 * lands after it.
 */
function NumberRow({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  fallback,
  onChange
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fallback: number;
  onChange: (next: number) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm text-fleet-text-secondary">
          {label}
        </label>
        <p className="mt-0.5 text-xs text-fleet-text-muted">{hint}</p>
      </div>
      <BoundedNumber
        id={id}
        value={value}
        min={min}
        max={max}
        step={step}
        fallback={fallback}
        onCommit={onChange}
        className="w-24 shrink-0"
      />
    </div>
  );
}
