import { useEffect, useMemo, useState } from 'react';
import type {
  PiSettings,
  PiModelsFile,
  BuiltInProviderStatus,
  ModelEntry,
  PiProvider
} from '../../../../../shared/pi-config-types';
import type { RedactedBedrock } from '../../../../../shared/pi-env-injection-types';
import {
  PI_BUILT_IN_PROVIDERS,
  getPreset,
  type PiPresetId
} from '../../../../../shared/pi-presets';
import { PiDefaultsForm } from './PiDefaultsForm';
import { PiProvidersList } from './PiProvidersList';
import { PiWelcomeStrip } from './PiWelcomeStrip';
import { PiAdvancedAccordion } from './PiAdvancedAccordion';

const BEDROCK_PROVIDER_ID = 'amazon-bedrock';

type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      settings: PiSettings;
      models: PiModelsFile;
      builtIn: BuiltInProviderStatus[];
      bedrockEnv: RedactedBedrock | undefined;
    }
  | { kind: 'error'; message: string };

export function PiSection(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [modelCatalog, setModelCatalog] = useState<ModelEntry[]>([]);
  const [autoExpandId, setAutoExpandId] = useState<string | null>(null);

  useEffect(() => {
    void window.fleet.piConfig.listAvailableModels().then(setModelCatalog);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const [settings, models, builtIn, bedrockEnv] = await Promise.all([
          window.fleet.piConfig.readSettings(),
          window.fleet.piConfig.readModels(),
          window.fleet.piConfig.getBuiltInStatus(),
          window.fleet.piEnv.readBedrock()
        ]);
        if (!alive) return;
        setState({ kind: 'ready', settings, models, builtIn, bedrockEnv });
      } catch (err) {
        if (!alive) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    };
    void load();
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const reload = async (): Promise<void> => {
    try {
      const [settings, models, builtIn, bedrockEnv] = await Promise.all([
        window.fleet.piConfig.readSettings(),
        window.fleet.piConfig.readModels(),
        window.fleet.piConfig.getBuiltInStatus(),
        window.fleet.piEnv.readBedrock()
      ]);
      setState({ kind: 'ready', settings, models, builtIn, bedrockEnv });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const bedrockHasEnvConfig = useMemo(() => {
    if (state.kind !== 'ready' || !state.bedrockEnv) return false;
    const b = state.bedrockEnv;
    return Boolean(
      b.region || b.profile || b.accessKeyId || b.secretAccessKeyPresent || b.bearerTokenPresent
    );
  }, [state]);

  const configuredCount = useMemo(() => {
    if (state.kind !== 'ready') return 0;
    const builtInAuthed = state.builtIn.filter((s) => s.authenticated).length;
    const customCount = Object.keys(state.models.providers).filter(
      (id) => id !== BEDROCK_PROVIDER_ID
    ).length;
    const bedrockBuiltInAuthed = state.builtIn.some(
      (s) => s.id === BEDROCK_PROVIDER_ID && s.authenticated
    );
    const managedBedrockOnly = bedrockHasEnvConfig && !bedrockBuiltInAuthed ? 1 : 0;
    return builtInAuthed + customCount + managedBedrockOnly;
  }, [state, bedrockHasEnvConfig]);

  if (state.kind === 'loading') {
    return <div className="text-sm text-neutral-400">Loading pi configuration…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded bg-red-900/30 border border-red-700/50 px-3 py-2 text-sm text-red-300">
        Failed to read pi config: {state.message}
        <button
          onClick={() => void window.fleet.piConfig.openConfigFolder()}
          className="ml-2 underline transition active:scale-[0.97]"
        >
          Open config folder
        </button>
      </div>
    );
  }

  const handleWelcomePick = (id: 'anthropic' | 'amazon-bedrock' | 'ollama'): void => {
    if (id === 'ollama') {
      // Ollama is a preset in PI_PRESETS — create a custom provider entry via handleAddCustom.
      handleAddCustom('ollama');
      return;
    }
    // Anthropic and Bedrock are built-ins; scrolling to + auto-expanding is handled by the list.
    setAutoExpandId(id);
  };

  const handleAddCustom = (presetId: PiPresetId): void => {
    const preset = getPreset(presetId);
    let id = preset.defaultProviderId;
    let i = 1;
    while (id in state.models.providers) id = `${preset.defaultProviderId}-${i++}`;
    void window.fleet.piConfig.writeProvider(id, { ...preset.defaults }).then(async () => {
      await reload();
      setAutoExpandId(id);
    });
  };

  const handleLegacyMigrate = async (): Promise<void> => {
    const legacy = state.models.providers[BEDROCK_PROVIDER_ID];
    if (!legacy) return;
    const next: PiProvider = { ...legacy };
    delete next.baseUrl;
    delete next.api;
    delete next.apiKey;
    delete next.compat;
    await window.fleet.piConfig.writeProvider(BEDROCK_PROVIDER_ID, next);
    await reload();
  };

  const handleLegacyKeepAsCustom = (): void => {
    // Banner is session-dismissed inside PiBedrockPanel; parent has nothing to persist.
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl text-neutral-100 font-semibold">Pi Agent</h1>
        <p className="text-sm text-neutral-500">
          Configure which models pi can use. Pi shares this config with your CLI.
        </p>
      </header>

      {configuredCount === 0 && (
        <PiWelcomeStrip onPick={handleWelcomePick} onShowMore={() => setAutoExpandId(null)} />
      )}

      <PiProvidersList
        builtIn={state.builtIn}
        models={state.models}
        bedrockHasEnvConfig={bedrockHasEnvConfig}
        autoExpandId={autoExpandId}
        onExpandConsumed={() => setAutoExpandId(null)}
        onAddCustom={handleAddCustom}
        onSaveCustom={async (id, provider) => {
          await window.fleet.piConfig.writeProvider(id, provider);
          await reload();
        }}
        onDeleteCustom={async (id) => {
          await window.fleet.piConfig.deleteProvider(id);
          await reload();
        }}
        onLegacyMigrate={handleLegacyMigrate}
        onLegacyKeepAsCustom={handleLegacyKeepAsCustom}
      />

      <PiDefaultsForm
        settings={state.settings}
        models={state.models}
        modelCatalog={modelCatalog}
        builtInProviderIds={PI_BUILT_IN_PROVIDERS.map((p) => p.id)}
        onChange={async (patch) => {
          await window.fleet.piConfig.writeSettings(patch);
          await reload();
        }}
      />

      <PiAdvancedAccordion
        settings={state.settings}
        onChange={async (patch) => {
          await window.fleet.piConfig.writeSettings(patch);
          await reload();
        }}
        onOpenConfigFolder={async () => window.fleet.piConfig.openConfigFolder()}
      />
    </div>
  );
}
