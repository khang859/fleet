import { Lightbulb } from 'lucide-react';
import {
  ADVISOR_MAX_TOKENS,
  ADVISOR_MIN_TOKENS,
  DEFAULT_AGENT_ADVISOR,
  type AgentAdvisorConfig
} from '../../../../../shared/agent-advisor';
import type { AgentCatalogModel } from '../../../../../shared/agent-types';
import { RoleCard, inputCls } from './controls';
import { ModelSelect } from './ModelSelect';
import { Toggle } from './Toggle';

/**
 * The stronger model the coding model may consult.
 *
 * A model card that picks a model Fleet never calls. OpenRouter runs the
 * consultation inside the executor's own turn, so there is no request here to
 * put a temperature or a reasoning effort on - only which model, what it is
 * told to be, and how much of it to read.
 *
 * The card insists on a model rather than defaulting to one. Left unset,
 * OpenRouter falls back to the executing model, and a consultation where the
 * model asks itself is a second bill for the first opinion.
 */
export function AgentAdvisorSettings({
  models,
  config,
  onChange
}: {
  models: AgentCatalogModel[];
  config: AgentAdvisorConfig;
  onChange: (patch: Partial<AgentAdvisorConfig>) => void;
}): React.JSX.Element {
  return (
    <RoleCard
      title="Advisor"
      description="Lets the coding model consult a stronger one mid-turn - before committing to an approach, when it is stuck, before calling a task done. OpenRouter runs the consultation and bills per question."
      icon={<Lightbulb size={16} />}
    >
      <Row
        id="agent-advisor-enabled"
        label="Consult a stronger model"
        hint="The advisor cannot see this folder or this conversation. It answers the question it is given, and nothing else."
      >
        <Toggle
          id="agent-advisor-enabled"
          checked={config.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
      </Row>

      {config.enabled && (
        <>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-fleet-text-secondary">Advisor model</label>
            <p className="text-xs text-fleet-text-muted">
              Worth being dearer than the coding model - a cheaper second opinion is the first
              opinion again. Until one is chosen the tool is not offered at all.
            </p>
            <ModelSelect
              models={models}
              value={config.model}
              onChange={(model) => onChange({ model })}
              allowNone
              noneLabel="No advisor"
              placeholder="Choose a model"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="agent-advisor-instructions"
              className="text-sm text-fleet-text-secondary"
            >
              Instructions
            </label>
            <p className="text-xs text-fleet-text-muted">
              Optional. Who the advisor should be - &ldquo;a staff engineer who has maintained this
              kind of system for ten years, and is decisive&rdquo;.
            </p>
            <textarea
              id="agent-advisor-instructions"
              rows={3}
              value={config.instructions}
              placeholder="Left blank, the advisor answers as itself."
              onChange={(e) => onChange({ instructions: e.target.value })}
              className={`${inputCls} resize-y font-sans`}
            />
          </div>

          <MaxTokensField
            value={config.maxTokens}
            onChange={(maxTokens) => onChange({ maxTokens })}
          />
        </>
      )}
    </RoleCard>
  );
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
 * How long one piece of advice may run.
 *
 * Paid for twice, which is what the hint has to get across: once to produce, at
 * the stronger model's rate, and again on every round afterwards, because the
 * advice stays in the transcript the executor re-reads. Clamped on the way out
 * rather than while typing, like the page limit next door.
 */
function MaxTokensField({
  value,
  onChange
}: {
  value: number;
  onChange: (next: number) => void;
}): React.JSX.Element {
  return (
    <Row
      id="agent-advisor-max-tokens"
      label="Advice length"
      hint="Tokens for one consultation, thinking included. Paid for twice: once to write, and again every round it stays in the transcript."
    >
      <input
        id="agent-advisor-max-tokens"
        type="number"
        inputMode="numeric"
        min={ADVISOR_MIN_TOKENS}
        max={ADVISOR_MAX_TOKENS}
        step={256}
        value={value}
        onChange={(e) => {
          const parsed = Number(e.target.value.trim());
          if (!Number.isFinite(parsed)) {
            onChange(DEFAULT_AGENT_ADVISOR.maxTokens);
            return;
          }
          onChange(Math.min(ADVISOR_MAX_TOKENS, Math.max(ADVISOR_MIN_TOKENS, Math.round(parsed))));
        }}
        className={`${inputCls} w-24 tabular-nums`}
      />
    </Row>
  );
}
