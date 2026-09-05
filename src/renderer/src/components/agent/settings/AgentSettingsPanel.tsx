import { useEffect, useMemo } from 'react';
import { Code2, RefreshCw, TriangleAlert } from 'lucide-react';
import type {
  AgentImageConfig,
  AgentModelConfig,
  AgentToolMode,
  AgentWebFetchConfig
} from '../../../../../shared/agent-types';
import type { AgentWebSearchConfig } from '../../../../../shared/agent-web-search';
import type { AgentHostedFetchConfig } from '../../../../../shared/agent-hosted-fetch';
import type { AgentFusionConfig } from '../../../../../shared/agent-fusion';
import type { AgentAdvisorConfig } from '../../../../../shared/agent-advisor';
import { AGENT_TOOL_MODES, DEFAULT_AGENT_SETTINGS } from '../../../../../shared/agent-types';
import {
  AGENT_VOICE_MODELS,
  DEFAULT_AGENT_VOICE_SETTINGS
} from '../../../../../shared/agent-voice';
import { useAgentStore } from '../../../store/agent-store';
import { useSettingsStore } from '../../../store/settings-store';
import { SectionShell, FieldGroup, Field } from './primitives';
import { SecretInput } from './SecretInput';
import { AgentRoleSettings } from './AgentRoleSettings';
import { AgentImageSettings } from './AgentImageSettings';
import { AgentWebSettings } from './AgentWebSettings';
import { AgentWebSearchSettings } from './AgentWebSearchSettings';
import { AgentHostedFetchSettings } from './AgentHostedFetchSettings';
import { AgentFusionSettings } from './AgentFusionSettings';
import { AgentAdvisorSettings } from './AgentAdvisorSettings';
import { SystemPromptField } from './SystemPromptField';
import { CompactionField } from './CompactionField';
import { MaxToolRoundsField } from './MaxToolRoundsField';
import { ClassifierNoteField } from './ClassifierNoteField';
import { ModelSelect } from './ModelSelect';
import { selectCls } from './controls';
import { LocalEndpointsSection } from './endpoints/LocalEndpointsSection';
import { McpSection } from './mcp/McpSection';
import { SkillsSection } from './skills/SkillsSection';
import { MemorySection } from './memory/MemorySection';
import { relativeTime } from './format';

/**
 * A `<select>` hands back a plain string, and this one decides who gets to say
 * what runs on the machine. Narrowed by looking the value up rather than
 * asserted: anything the list does not contain is a bug somewhere, and the mode
 * that asks is the one to have it in.
 */
function toAgentToolMode(value: string): AgentToolMode {
  return AGENT_TOOL_MODES.find((mode) => mode === value) ?? DEFAULT_AGENT_SETTINGS.toolMode;
}

function validateOpenRouterKey(key: string): string | null {
  if (/\s/.test(key)) return 'Keys cannot contain spaces.';
  if (!key.startsWith('sk-or-')) return 'OpenRouter keys start with "sk-or-".';
  return null;
}

/**
 * Settings for every agent pane. Deliberately app-wide rather than per pane:
 * a pane is a folder to work in, not a separate provider account.
 *
 * The one exception is `cwd`, and it is an exception because memory has a tier
 * that lives inside the repository. Which entries exist is a question about a
 * folder, and this panel is drawn inside a pane that has one - so it is asked
 * with the pane's own answer rather than guessed from the recent list.
 */
export function AgentSettingsPanel({ cwd }: { cwd: string }): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  // Field by field rather than the whole store. The agent store also holds every
  // pane's transcript, which is rewritten as each token arrives - so subscribing
  // to all of it re-renders this panel, and the model catalog inside it, once per
  // token of a turn happening in some other pane entirely.
  const catalog = useAgentStore((s) => s.catalog);
  const loadingModels = useAgentStore((s) => s.loadingModels);
  const keyPresent = useAgentStore((s) => s.keyPresent);
  const loadModels = useAgentStore((s) => s.loadModels);
  const loadKey = useAgentStore((s) => s.loadKey);
  const saveKey = useAgentStore((s) => s.saveKey);
  const clearKey = useAgentStore((s) => s.clearKey);

  useEffect(() => {
    void loadModels();
    void loadKey();
  }, [loadModels, loadKey]);

  const agent = settings?.ai.agent ?? DEFAULT_AGENT_SETTINGS;
  const models = useMemo(() => catalog?.models ?? [], [catalog]);
  const codingModels = useMemo(() => models.filter((m) => m.supportsTools), [models]);
  // Counted apart from the download below, because the two halves of this list
  // are refreshed by entirely different things: one by a button, the other by
  // somebody starting a server.
  const localCount = useMemo(() => models.filter((m) => m.local !== undefined).length, [models]);
  // Its own list rather than a filter over the one above: the images endpoint
  // keeps a separate register, and most of what is on it has no place in a
  // catalog of models you can hold a conversation with.
  const imageModels = useMemo(() => catalog?.imageModels ?? [], [catalog]);
  // The curated transcription list, not the whole catalog: it is short enough
  // to be a choice, and each entry states whether choosing it keeps the hints.
  const voiceModels = useMemo(
    () =>
      AGENT_VOICE_MODELS.map((m) => ({
        ...m,
        description: null,
        contextLimit: null,
        outputLimit: null,
        supportsTools: false,
        supportsTemperature: false,
        inputImage: false,
        outputImage: false,
        reasoning: [],
        cost: null,
        releaseDate: null,
        defaultTemperature: null,
        defaultReasoningEnabled: null,
        defaultReasoningEffort: null
      })),
    []
  );

  // Whether the chosen transcription model is one the hints reach at all.
  const hintsApply = AGENT_VOICE_MODELS.find((m) => m.id === agent.voice.model)?.hints === true;

  const patchCoding = (patch: Partial<AgentModelConfig>): void => {
    void updateSettings({ ai: { agent: { coding: { ...agent.coding, ...patch } } } });
  };

  const patchImage = (patch: Partial<AgentImageConfig>): void => {
    void updateSettings({ ai: { agent: { image: { ...agent.image, ...patch } } } });
  };

  const patchWebFetch = (patch: Partial<AgentWebFetchConfig>): void => {
    void updateSettings({ ai: { agent: { webFetch: { ...agent.webFetch, ...patch } } } });
  };

  const patchHostedFetch = (patch: Partial<AgentHostedFetchConfig>): void => {
    void updateSettings({ ai: { agent: { hostedFetch: { ...agent.hostedFetch, ...patch } } } });
  };
  const patchFusion = (patch: Partial<AgentFusionConfig>): void => {
    void updateSettings({ ai: { agent: { fusion: { ...agent.fusion, ...patch } } } });
  };
  const patchAdvisor = (patch: Partial<AgentAdvisorConfig>): void => {
    void updateSettings({ ai: { agent: { advisor: { ...agent.advisor, ...patch } } } });
  };

  const patchWebSearch = (patch: Partial<AgentWebSearchConfig>): void => {
    void updateSettings({ ai: { agent: { webSearch: { ...agent.webSearch, ...patch } } } });
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-6">
      <SectionShell title="Agent settings" description="Shared by every agent pane in Fleet.">
        <FieldGroup title="Provider">
          <Field
            label="OpenRouter API key"
            description="Optional. Stored encrypted on this device, and never sent anywhere but OpenRouter. Without one, Fleet runs on the local servers below - though image generation and voice dictation are OpenRouter's alone and stay off."
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

        <LocalEndpointsSection
          endpoints={agent.localEndpoints}
          onChange={(localEndpoints) => void updateSettings({ ai: { agent: { localEndpoints } } })}
        />

        <FieldGroup title="Models">
          <AgentRoleSettings
            title="Coding agent"
            description="Writes code and drives tools. Only models that support tool calling are listed."
            icon={<Code2 size={16} />}
            models={codingModels}
            config={agent.coding}
            onChange={patchCoding}
          />
          <AgentImageSettings models={imageModels} config={agent.image} onChange={patchImage} />
          <AgentWebSettings config={agent.webFetch} onChange={patchWebFetch} />
          {/* Directly under Fleet's own reader, because the card is about the
              boundary between the two and reading them apart is how somebody
              turns this on expecting a better fetch. */}
          <AgentHostedFetchSettings
            config={agent.hostedFetch}
            onChange={patchHostedFetch}
            hasKey={keyPresent}
          />
          <AgentWebSearchSettings
            config={agent.webSearch}
            onChange={patchWebSearch}
            hasKey={keyPresent}
          />
          <AgentAdvisorSettings models={models} config={agent.advisor} onChange={patchAdvisor} />
          <AgentFusionSettings models={models} config={agent.fusion} onChange={patchFusion} />
        </FieldGroup>

        <FieldGroup title="Sessions">
          <Field
            label="Title model"
            description="Names a session once its first turn finishes. Any model will do - naming calls no tools."
            layout="stack"
          >
            <ModelSelect
              models={models}
              value={agent.titleModel}
              onChange={(titleModel) => void updateSettings({ ai: { agent: { titleModel } } })}
              allowNone
              noneLabel="Use the coding model"
            />
          </Field>
        </FieldGroup>

        <FieldGroup title="Voice dictation">
          <Field
            label="Dictation model"
            description="Turns a spoken prompt into text. Only Groq-served models honour the recognition hints (project name, branch, coding terms); the others transcribe without them."
            layout="stack"
          >
            <ModelSelect
              models={voiceModels}
              value={agent.voice.model}
              onChange={(model) =>
                void updateSettings({
                  ai: {
                    agent: {
                      voice: { ...agent.voice, model: model ?? DEFAULT_AGENT_VOICE_SETTINGS.model }
                    }
                  }
                })
              }
            />
          </Field>
          <Field
            label="Recognition hints"
            description={
              hintsApply
                ? 'The project name, branch and coding vocabulary go up with the audio, so identifiers come back spelled the way they are written.'
                : 'This model ignores them, so identifiers may transcribe imprecisely.'
            }
          >
            {/* The state, not a second copy of the sentence beside it: the row
                reads label, explanation, answer, like every other one here. */}
            <span
              className={`text-xs ${hintsApply ? 'text-fleet-text-secondary' : 'text-fleet-text-muted'}`}
            >
              {hintsApply ? 'On' : 'Off'}
            </span>
          </Field>
        </FieldGroup>

        <FieldGroup title="Permissions">
          <Field
            label="Who answers"
            description="What a command your rules have not settled does next. The picker in the composer sets the same thing. Full access runs everything but a deny rule, and is back to Ask on the next start."
            htmlFor="agent-tool-mode"
          >
            <select
              id="agent-tool-mode"
              value={agent.toolMode}
              onChange={(e) =>
                void updateSettings({
                  ai: { agent: { toolMode: toAgentToolMode(e.target.value) } }
                })
              }
              className={selectCls}
            >
              <option value="ask">Ask every time</option>
              <option value="auto">Auto: decide the ordinary ones</option>
              <option value="full">Full access: never ask</option>
            </select>
          </Field>
          <Field
            label="Auto-approval model"
            description="Judges one command at a time in Auto. Small and fast is what this wants - it never sees the conversation, only the command line."
            layout="stack"
          >
            <ModelSelect
              models={models}
              value={agent.classifierModel}
              onChange={(classifierModel) =>
                void updateSettings({ ai: { agent: { classifierModel } } })
              }
              allowNone
              noneLabel="Use the coding model"
            />
          </Field>
          <ClassifierNoteField
            value={agent.classifierNote}
            onChange={(classifierNote) =>
              void updateSettings({ ai: { agent: { classifierNote } } })
            }
          />
        </FieldGroup>

        <McpSection />

        <SkillsSection />

        <MemorySection cwd={cwd} />

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
          <MaxToolRoundsField
            value={agent.maxToolRounds}
            onChange={(maxToolRounds) => void updateSettings({ ai: { agent: { maxToolRounds } } })}
          />
        </FieldGroup>

        <CatalogStatus
          count={models.length - localCount}
          localCount={localCount}
          imageCount={imageModels.length}
          fetchedAt={catalog?.fetchedAt ?? 0}
          error={catalog?.error ?? null}
          loading={loadingModels}
          onRefresh={() => void loadModels(true)}
        />
      </SectionShell>
    </div>
  );
}

/** Where the model lists came from, and how to get newer ones. */
function CatalogStatus({
  count,
  localCount,
  imageCount,
  fetchedAt,
  error,
  loading,
  onRefresh
}: {
  /** OpenRouter models alone. The local ones are counted separately. */
  count: number;
  localCount: number;
  imageCount: number;
  fetchedAt: number;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  const local = localCount === 1 ? '1 local model' : `${localCount} local models`;
  return (
    <div className="space-y-2 border-t border-fleet-border pt-4">
      <div className="flex items-center justify-between gap-3 text-xs text-fleet-text-muted">
        <span className="min-w-0 truncate">
          {loading
            ? 'Loading models…'
            : count === 0
              ? // Not "no models". A local-only setup is a working setup, and
                // reporting it as an empty catalog would be the panel calling
                // the user's own servers nothing.
                localCount === 0
                ? 'No models loaded yet.'
                : `${local}. No OpenRouter models downloaded.`
              : `${count} OpenRouter models and ${imageCount} image models${fetchedAt > 0 ? `, updated ${relativeTime(fetchedAt)}` : ''}${localCount > 0 ? `, plus ${local}` : ''}.`}
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
          <span>
            Could not refresh the OpenRouter model lists ({error}). Showing the last downloaded
            ones.
            {/* Said plainly, because the warning above is about a download this
                user may have no stake in - a local-only setup should not read a
                network failure as though its own models were affected. */}
            {localCount > 0 && ' Your local models are unaffected.'}
          </span>
        </p>
      )}
    </div>
  );
}
