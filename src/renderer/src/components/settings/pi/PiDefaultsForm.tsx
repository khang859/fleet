import { useMemo } from 'react';
import { SettingRow } from '../SettingRow';
import type {
  PiSettings,
  PiModelsFile,
  PiThinkingLevel,
  ModelEntry
} from '../../../../../shared/pi-config-types';

type Props = {
  settings: PiSettings;
  models: PiModelsFile;
  modelCatalog: ModelEntry[];
  builtInProviderIds: string[];
  onChange: (patch: Partial<PiSettings>) => void | Promise<void>;
};

const THINKING_LEVELS: PiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function parseThinkingLevel(value: string): PiThinkingLevel | undefined {
  return THINKING_LEVELS.find((l) => l === value);
}

export function PiDefaultsForm({
  settings,
  models,
  modelCatalog,
  builtInProviderIds,
  onChange
}: Props): React.JSX.Element {
  const providerIds = useMemo(() => {
    const customIds = Object.keys(models.providers);
    return [...new Set([...builtInProviderIds, ...customIds])].sort();
  }, [models, builtInProviderIds]);

  const modelsForProvider = useMemo(() => {
    const fromCatalog = modelCatalog
      .filter((m) => m.providerId === settings.defaultProvider)
      .map((m) => ({ id: m.modelId, label: m.label }));
    const fromCustom = (models.providers[settings.defaultProvider ?? '']?.models ?? []).map(
      (m) => ({ id: m.id, label: m.name ?? m.id })
    );
    return [...fromCustom, ...fromCatalog];
  }, [modelCatalog, models, settings.defaultProvider]);

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold text-neutral-200">Defaults</h2>
      <p className="text-xs text-neutral-500 -mt-3">
        Used when you open a new Pi tab without specifying otherwise.
      </p>

      <div>
        <SettingRow label="Default provider">
          <select
            value={settings.defaultProvider ?? ''}
            onChange={(e) =>
              void onChange({
                defaultProvider: e.target.value || undefined,
                defaultModel: undefined
              })
            }
            className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
          >
            <option value="">(none)</option>
            {providerIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </SettingRow>
      </div>

      <div>
        <SettingRow label="Default model">
          {modelsForProvider.length > 0 ? (
            <select
              value={settings.defaultModel ?? ''}
              onChange={(e) => void onChange({ defaultModel: e.target.value || undefined })}
              className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
            >
              <option value="">(none)</option>
              {modelsForProvider.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={settings.defaultModel ?? ''}
              onChange={(e) => void onChange({ defaultModel: e.target.value || undefined })}
              placeholder="Model id"
              className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 w-64"
            />
          )}
        </SettingRow>
      </div>

      <div>
        <SettingRow label="Thinking level">
          <select
            value={settings.defaultThinkingLevel ?? ''}
            onChange={(e) =>
              void onChange({ defaultThinkingLevel: parseThinkingLevel(e.target.value) })
            }
            className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
          >
            <option value="">(default)</option>
            {THINKING_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </SettingRow>
      </div>
    </section>
  );
}
