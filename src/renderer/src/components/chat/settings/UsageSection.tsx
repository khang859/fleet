import { useChatSettings } from './use-chat-settings';
import { SectionShell, FieldGroup, Field } from './primitives';
import { Toggle } from './Toggle';
import { inputCls } from './controls';

export function UsageSection(): React.JSX.Element {
  const { settings, patch } = useChatSettings();
  const { usage } = settings;

  return (
    <SectionShell
      title="Usage & Cost"
      description="Surface token counts and spend; cache the stable prompt prefix to cut input cost."
    >
      <FieldGroup>
        <Field
          label="Cost meter"
          description="Show per-message usage and a per-conversation total."
          htmlFor="cost-meter"
        >
          <Toggle
            id="cost-meter"
            checked={usage.showMeter}
            onChange={(v) => void patch({ usage: { ...usage, showMeter: v } })}
          />
        </Field>

        <Field
          label="Prompt caching"
          description="Cache the system prompt + tool definitions (cache hits ≈ 10% of input price, where supported)."
          htmlFor="prompt-caching"
        >
          <Toggle
            id="prompt-caching"
            checked={usage.promptCaching}
            onChange={(v) => void patch({ usage: { ...usage, promptCaching: v } })}
          />
        </Field>

        <Field
          label="Budget warning"
          description="The meter turns amber once a conversation passes this. Empty = no warning."
        >
          <div className="flex items-center gap-2">
            <span className="text-sm text-fleet-text-muted">$</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={usage.budgetWarnUsd ?? ''}
              placeholder="off"
              onChange={(e) => {
                const v = e.target.value.trim();
                void patch({
                  usage: { ...usage, budgetWarnUsd: v === '' ? null : Math.max(0, Number(v) || 0) }
                });
              }}
              className={`${inputCls} w-28`}
            />
            <span className="text-xs text-fleet-text-muted">/ conversation</span>
          </div>
        </Field>
      </FieldGroup>
    </SectionShell>
  );
}
