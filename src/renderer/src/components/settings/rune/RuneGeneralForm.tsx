import { RuneSelect, RuneToggle, RuneText } from './RuneControls';
import {
  RUNE_PROVIDERS,
  RUNE_EFFORTS,
  RUNE_ICON_MODES,
  RUNE_ACTIVITY_MODES,
  RUNE_SEARCH_ENABLED,
  RUNE_SEARCH_PROVIDERS,
  RUNE_COMPACT_THRESHOLDS,
  RUNE_SUBAGENT_CONCURRENCY,
  RUNE_SUBAGENT_TIMEOUTS,
  RUNE_SUBAGENT_RETAIN,
  RUNE_PROVIDER_MODEL_FIELD,
  type RuneProvider,
  type RuneSettings
} from '../../../../../shared/rune-config-types';

function isRuneProvider(value: string): value is RuneProvider {
  return (RUNE_PROVIDERS as readonly string[]).includes(value);
}

type Props = {
  settings: RuneSettings;
  onChange: (patch: Partial<RuneSettings>) => Promise<void> | void;
};

// rune's DefaultSettings (internal/config/settings.go) — what the agent uses
// when a key is absent from settings.json. The UI shows these as the current
// value so the dropdowns reflect rune's real behavior.
const PROVIDER_OPTIONS = [
  { value: '', label: 'none' },
  ...RUNE_PROVIDERS.map((p) => ({ value: p, label: p }))
];

function numOptions(
  values: readonly number[],
  suffix = ''
): Array<{ value: string; label: string }> {
  return values.map((v) => ({ value: String(v), label: `${v}${suffix}` }));
}

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-neutral-200">{title}</h2>
      {children}
    </section>
  );
}

export function RuneGeneralForm({ settings, onChange }: Props): React.JSX.Element {
  const provider = settings.provider ?? '';
  const web = settings.web ?? {};
  const subagents = settings.subagents ?? {};
  const autoCompact = settings.auto_compact ?? {};

  const modelField = isRuneProvider(provider) ? RUNE_PROVIDER_MODEL_FIELD[provider] : undefined;
  const rawModel = modelField ? settings[modelField] : undefined;
  const modelValue = typeof rawModel === 'string' ? rawModel : '';

  return (
    <div className="space-y-6">
      <Section title="Provider">
        <RuneSelect
          label="Provider"
          value={provider}
          options={PROVIDER_OPTIONS}
          onChange={(v) => void onChange({ provider: v })}
        />
        {modelField && (
          <RuneText
            label={`${provider} model`}
            value={modelValue}
            placeholder="model id"
            // Send the raw value (incl. empty) — rune treats an empty model as
            // "use the provider default". Sending undefined would be skipped by
            // the main-process merge, making a clear a silent no-op.
            onCommit={(v) => void onChange({ [modelField]: v })}
          />
        )}
      </Section>

      <Section title="Mind">
        <RuneSelect
          label="Thinking effort"
          value={settings.reasoning_effort ?? 'medium'}
          options={RUNE_EFFORTS}
          onChange={(v) => void onChange({ reasoning_effort: v })}
        />
      </Section>

      <Section title="Interface">
        <RuneSelect
          label="Icon mode"
          value={settings.icon_mode ?? 'unicode'}
          options={RUNE_ICON_MODES}
          onChange={(v) => void onChange({ icon_mode: v })}
        />
        <RuneSelect
          label="Activity indicator"
          value={settings.activity_mode ?? 'arcane'}
          options={RUNE_ACTIVITY_MODES}
          onChange={(v) => void onChange({ activity_mode: v })}
        />
      </Section>

      <Section title="Memory">
        <RuneToggle
          label="Auto compact"
          checked={autoCompact.enabled ?? true}
          onChange={(checked) => void onChange({ auto_compact: { enabled: checked } })}
        />
        <RuneSelect
          label="Compact threshold"
          value={String(autoCompact.threshold_pct ?? 80)}
          options={numOptions(RUNE_COMPACT_THRESHOLDS, '%')}
          onChange={(v) => void onChange({ auto_compact: { threshold_pct: Number(v) } })}
        />
      </Section>

      <Section title="Web">
        <RuneToggle
          label="Web fetch"
          checked={web.fetch_enabled ?? true}
          onChange={(checked) => void onChange({ web: { fetch_enabled: checked } })}
        />
        <RuneToggle
          label="Fetch private URLs"
          checked={web.fetch_allow_private ?? false}
          onChange={(checked) => void onChange({ web: { fetch_allow_private: checked } })}
        />
        <RuneSelect
          label="Web search"
          value={web.search_enabled ?? 'auto'}
          options={RUNE_SEARCH_ENABLED}
          onChange={(v) => void onChange({ web: { search_enabled: v } })}
        />
        <RuneSelect
          label="Search provider"
          value={web.search_provider ?? 'auto'}
          options={RUNE_SEARCH_PROVIDERS}
          onChange={(v) => void onChange({ web: { search_provider: v } })}
        />
      </Section>

      <Section title="Subagents">
        <RuneToggle
          label="Subagents"
          checked={subagents.enabled ?? true}
          onChange={(checked) => void onChange({ subagents: { enabled: checked } })}
        />
        <RuneSelect
          label="Max concurrent"
          value={String(subagents.max_concurrent ?? 4)}
          options={numOptions(RUNE_SUBAGENT_CONCURRENCY)}
          onChange={(v) => void onChange({ subagents: { max_concurrent: Number(v) } })}
        />
        <RuneSelect
          label="Default timeout"
          value={String(subagents.default_timeout_secs ?? 600)}
          options={numOptions(RUNE_SUBAGENT_TIMEOUTS, 's')}
          onChange={(v) => void onChange({ subagents: { default_timeout_secs: Number(v) } })}
        />
        <RuneSelect
          label="Keep recent"
          value={String(subagents.max_completed_retain ?? 100)}
          options={numOptions(RUNE_SUBAGENT_RETAIN)}
          onChange={(v) => void onChange({ subagents: { max_completed_retain: Number(v) } })}
        />
      </Section>
    </div>
  );
}
