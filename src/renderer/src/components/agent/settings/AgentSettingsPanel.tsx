import { useEffect, useMemo } from 'react';
import { Code2, RefreshCw, TriangleAlert } from 'lucide-react';
import type {
  AgentImageConfig,
  AgentModelConfig,
  AgentToolMode
} from '../../../../../shared/agent-types';
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
import { SystemPromptField } from './SystemPromptField';
import { CompactionField } from './CompactionField';
import { MaxToolRoundsField } from './MaxToolRoundsField';
import { ClassifierNoteField } from './ClassifierNoteField';
import { ModelSelect } from './ModelSelect';
import { selectCls } from './controls';
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

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-6">
      <SectionShell title="Agent settings" description="Shared by every agent pane in Fleet.">
        <FieldGroup title="Provider">
          <Field
            label="OpenRouter API key"
            description="Stored encrypted on this device, and never sent anywhere but OpenRouter."
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
            onChange={patchCoding}
          />
          <AgentImageSettings models={imageModels} config={agent.image} onChange={patchImage} />
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
            description="What a command your rules have not settled does next. The picker in the composer sets the same thing."
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
