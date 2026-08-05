import { useEffect, useMemo } from 'react';
import { Code2, ImagePlus, RefreshCw, TriangleAlert } from 'lucide-react';
import type { AgentModelConfig } from '../../../../../shared/agent-types';
import { DEFAULT_AGENT_SETTINGS } from '../../../../../shared/agent-types';
import { useAgentStore } from '../../../store/agent-store';
import { useSettingsStore } from '../../../store/settings-store';
// Layout primitives and the key field come from the Chat settings kit: both
// surfaces are the same kind of form, and one implementation keeps them so.
import { SectionShell, FieldGroup, Field } from '../../chat/settings/primitives';
import { SecretInput } from '../../chat/settings/SecretInput';
import { AgentRoleSettings } from './AgentRoleSettings';
import { SystemPromptField } from './SystemPromptField';
import { CompactionField } from './CompactionField';

function validateOpenRouterKey(key: string): string | null {
  if (/\s/.test(key)) return 'Keys cannot contain spaces.';
  if (!key.startsWith('sk-or-')) return 'OpenRouter keys start with "sk-or-".';
  return null;
}

/**
 * Settings for every agent pane. Deliberately app-wide rather than per pane:
 * a pane is a folder to work in, not a separate provider account.
 */
export function AgentSettingsPanel(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { catalog, loadingModels, keyPresent, loadModels, loadKey, saveKey, clearKey } =
    useAgentStore();

  useEffect(() => {
    void loadModels();
    void loadKey();
  }, [loadModels, loadKey]);

  const agent = settings?.ai.agent ?? DEFAULT_AGENT_SETTINGS;
  const models = useMemo(() => catalog?.models ?? [], [catalog]);
  const codingModels = useMemo(() => models.filter((m) => m.supportsTools), [models]);
  const imageModels = useMemo(() => models.filter((m) => m.outputImage), [models]);

  const patchRole = (role: 'coding' | 'image', patch: Partial<AgentModelConfig>): void => {
    void updateSettings({ ai: { agent: { [role]: { ...agent[role], ...patch } } } });
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-6">
      <SectionShell title="Agent settings" description="Shared by every agent pane in Fleet.">
        <FieldGroup title="Provider">
          <Field
            label="OpenRouter API key"
            description="Stored encrypted on this device, and shared with the Chat tool - setting it here sets it there."
            layout="stack"
            htmlFor="agent-openrouter-key"
          >
            <SecretInput
              inputId="agent-openrouter-key"
              present={keyPresent}
              onSave={saveKey}
              onClear={clearKey}
              placeholder="sk-or-…"
              validate={validateOpenRouterKey}
            />
          </Field>
        </FieldGroup>

        <FieldGroup title="Models">
          <AgentRoleSettings
            title="Coding agent"
            description="Writes code and drives tools. Only models that support tool calling are listed."
            icon={<Code2 size={16} />}
            models={codingModels}
            config={agent.coding}
            onChange={(patch) => patchRole('coding', patch)}
          />
          <AgentRoleSettings
            title="Image agent"
            description="Generates and edits images on request. None turns image generation off."
            icon={<ImagePlus size={16} />}
            models={imageModels}
            config={agent.image}
            onChange={(patch) => patchRole('image', patch)}
            allowNone
            noneLabel="None - image generation off"
          />
        </FieldGroup>

        <FieldGroup title="Instructions">
          <SystemPromptField
            value={agent.systemPrompt}
            onChange={(systemPrompt) => void updateSettings({ ai: { agent: { systemPrompt } } })}
          />
        </FieldGroup>

        <FieldGroup title="Context">
          <CompactionField
            value={agent.compactThreshold}
            onChange={(compactThreshold) =>
              void updateSettings({ ai: { agent: { compactThreshold } } })
            }
          />
        </FieldGroup>

        <CatalogStatus
          count={models.length}
          fetchedAt={catalog?.fetchedAt ?? 0}
          error={catalog?.error ?? null}
          loading={loadingModels}
          onRefresh={() => void loadModels(true)}
        />
      </SectionShell>
    </div>
  );
}

/** Where the model list came from, and how to get a newer one. */
function CatalogStatus({
  count,
  fetchedAt,
  error,
  loading,
  onRefresh
}: {
  count: number;
  fetchedAt: number;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-2 border-t border-fleet-border pt-4">
      <div className="flex items-center justify-between gap-3 text-xs text-fleet-text-muted">
        <span className="min-w-0 truncate">
          {loading
            ? 'Loading models…'
            : count === 0
              ? 'No models loaded yet.'
              : `${count} OpenRouter models from models.dev${fetchedAt > 0 ? `, updated ${relativeTime(fetchedAt)}` : ''}.`}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-fleet-border-strong px-2 py-1 text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 disabled:opacity-40 focus-ring"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
      {error && (
        <p className="flex items-start gap-1.5 text-xs text-amber-400">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          <span>Could not reach models.dev ({error}). Showing the last downloaded list.</span>
        </p>
      )}
    </div>
  );
}

function relativeTime(epochMs: number): string {
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
