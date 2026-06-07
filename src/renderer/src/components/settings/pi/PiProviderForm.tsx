import { useState } from 'react';
import {
  parseApiKeyString,
  serializeApiKey,
  type PiApi,
  type PiApiKey,
  type PiProvider
} from '../../../../../shared/pi-config-types';
import { getPreset, type PiPresetId } from '../../../../../shared/pi-presets';
import { PiApiKeyInput } from './PiApiKeyInput';
import { PiModelsEditor } from './PiModelsEditor';

type Props = {
  initialId: string;
  initialProvider: PiProvider;
  presetId: PiPresetId;
  existingIds: string[];
  onSave: (id: string, provider: PiProvider) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onCancel: () => void;
};

const APIS: PiApi[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
];

function parseApi(value: string): PiApi | undefined {
  return APIS.find((a) => a === value);
}

export function PiProviderForm({
  initialId,
  initialProvider,
  presetId,
  existingIds,
  onSave,
  onDelete,
  onCancel
}: Props): React.JSX.Element {
  const preset = getPreset(presetId);

  const [id, setId] = useState(initialId);
  const [baseUrl, setBaseUrl] = useState(initialProvider.baseUrl ?? '');
  const [api, setApi] = useState<PiApi | undefined>(initialProvider.api);
  const [apiKey, setApiKey] = useState<PiApiKey | undefined>(
    parseApiKeyString(initialProvider.apiKey)
  );
  const [compatText, setCompatText] = useState(() =>
    initialProvider.compat ? JSON.stringify(initialProvider.compat, null, 2) : ''
  );
  const [compatError, setCompatError] = useState<string | null>(null);
  const [models, setModels] = useState(initialProvider.models ?? []);

  const duplicateId = id !== initialId && existingIds.includes(id);
  const idValid = id.trim().length > 0 && !duplicateId;

  const parseCompatOrNull = (): Record<string, unknown> | undefined | 'error' => {
    if (!compatText.trim()) return undefined;
    try {
      const parsed: unknown = JSON.parse(compatText);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'error';
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        out[k] = v;
      }
      return out;
    } catch {
      return 'error';
    }
  };

  const handleSave = async (): Promise<void> => {
    const compat = parseCompatOrNull();
    if (compat === 'error') {
      setCompatError('Must be a JSON object.');
      return;
    }
    setCompatError(null);

    const next: PiProvider = {
      ...initialProvider,
      baseUrl: baseUrl || undefined,
      api,
      apiKey: preset.skipApiKey || !apiKey ? undefined : serializeApiKey(apiKey),
      compat,
      models: models.length ? models : undefined
    };
    await onSave(id.trim(), next);
  };

  return (
    <div className="space-y-3 p-3 border-t border-neutral-700/50">
      {preset.hint && (
        <div className="rounded bg-neutral-800/60 border border-neutral-700 px-2 py-1.5 text-xs text-neutral-300">
          {preset.hint}
        </div>
      )}

      <div>
        <label className="text-xs text-neutral-400 block mb-1">Provider id</label>
        <input
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          className="w-64 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
        />
        {duplicateId && (
          <p className="text-xs text-red-400 mt-1">A provider with this id already exists.</p>
        )}
      </div>

      <div>
        <label className="text-xs text-neutral-400 block mb-1">Base URL</label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
          className="w-full bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
        />
      </div>

      <div>
        <label className="text-xs text-neutral-400 block mb-1">API</label>
        <select
          value={api ?? ''}
          onChange={(e) => setApi(parseApi(e.target.value))}
          className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
        >
          <option value="">(default)</option>
          {APIS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {!preset.skipApiKey && (
        <div>
          <label className="text-xs text-neutral-400 block mb-1">API key</label>
          <PiApiKeyInput value={apiKey} onChange={setApiKey} />
        </div>
      )}

      <div>
        <label className="text-xs text-neutral-400 block mb-1">Compat (advanced, JSON)</label>
        <textarea
          value={compatText}
          onChange={(e) => {
            setCompatText(e.target.value);
            setCompatError(null);
          }}
          rows={4}
          placeholder='{ "supportsDeveloperRole": false }'
          className="w-full bg-neutral-800 text-xs font-mono text-neutral-200 rounded px-2 py-1 border border-neutral-700"
        />
        {compatError && <p className="text-xs text-red-400 mt-1">{compatError}</p>}
      </div>

      <PiModelsEditor models={models} onChange={setModels} />

      <div className="flex justify-between pt-2">
        <button
          type="button"
          onClick={() => void onDelete()}
          className="px-2 py-1 text-xs rounded border border-red-700/50 text-red-400 hover:bg-red-900/30 transition active:scale-[0.97]"
        >
          Delete provider
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 text-sm rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800 transition active:scale-[0.97]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!idValid}
            onClick={() => void handleSave()}
            className="px-3 py-1 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white transition active:scale-[0.97] disabled:active:scale-100"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
