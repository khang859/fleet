import { useState, useEffect } from 'react';
import { useImageStore } from '../../store/image-store';

const RESOLUTIONS = ['0.5K', '1K', '2K', '4K'];
const FORMATS = ['png', 'jpeg', 'webp'];
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];

export function ImageSettings(): React.JSX.Element {
  const { config, loadConfig, updateConfig, actions, loadActions } = useImageStore();
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [actionModelInputs, setActionModelInputs] = useState<Record<string, string>>({});

  useEffect(() => {
    void loadConfig();
    void loadActions();
  }, [loadConfig, loadActions]);

  if (!config) return <div className="p-4 text-neutral-400">Loading settings...</div>;
  const provider = config.providers[config.defaultProvider];
  if (!provider) return <div className="p-4 text-neutral-400">No provider configured.</div>;

  const handleApiKeySave = (): void => {
    if (!apiKeyInput) return;
    void updateConfig({
      providers: { [config.defaultProvider]: { ...provider, apiKey: apiKeyInput } }
    });
    setApiKeyInput('');
  };

  const handleUpdate = (field: string, value: string): void => {
    void updateConfig({ providers: { [config.defaultProvider]: { ...provider, [field]: value } } });
  };

  const handleActionModelSave = (actionType: string): void => {
    const model = actionModelInputs[actionType];
    if (!model) return;
    const existingActions = provider.actions ?? {};
    void updateConfig({
      providers: {
        [config.defaultProvider]: {
          ...provider,
          actions: { ...existingActions, [actionType]: { model } }
        }
      }
    });
    setActionModelInputs((prev) => ({ ...prev, [actionType]: '' }));
  };

  return (
    <div className="p-4 space-y-4 max-w-md">
      <h3 className="text-sm font-medium text-neutral-200">Image Generation Settings</h3>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-neutral-400 mb-1">Provider</label>
          <div className="text-sm text-neutral-200 bg-neutral-800 rounded px-3 py-1.5">
            {config.defaultProvider}
          </div>
        </div>
        <div>
          <label className="block text-xs text-neutral-400 mb-1">API Key</label>
          <div className="flex gap-2">
            <input
              type={apiKeyVisible ? 'text' : 'password'}
              className="flex-1 bg-neutral-800 text-neutral-200 rounded px-3 py-1.5 text-sm border border-neutral-700 focus:border-cyan-500 outline-none"
              placeholder={provider.apiKey ? '••••••••' : 'Enter API key'}
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleApiKeySave();
              }}
            />
            <button
              className="text-xs text-neutral-400 hover:text-neutral-200 px-2"
              onClick={() => setApiKeyVisible(!apiKeyVisible)}
            >
              {apiKeyVisible ? 'Hide' : 'Show'}
            </button>
            <button
              className="text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded px-3 py-1.5"
              onClick={handleApiKeySave}
            >
              Save
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs text-neutral-400 mb-1">Default Model</label>
          <div className="text-sm text-neutral-200 bg-neutral-800 rounded px-3 py-1.5">
            {provider.defaultModel}
          </div>
        </div>
        <div>
          <label className="block text-xs text-neutral-400 mb-1">Default Resolution</label>
          <select
            className="w-full bg-neutral-800 text-neutral-200 rounded px-3 py-1.5 text-sm border border-neutral-700"
            value={provider.defaultResolution}
            onChange={(e) => handleUpdate('defaultResolution', e.target.value)}
          >
            {RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-neutral-400 mb-1">Default Format</label>
          <select
            className="w-full bg-neutral-800 text-neutral-200 rounded px-3 py-1.5 text-sm border border-neutral-700"
            value={provider.defaultOutputFormat}
            onChange={(e) => handleUpdate('defaultOutputFormat', e.target.value)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-neutral-400 mb-1">Default Aspect Ratio</label>
          <select
            className="w-full bg-neutral-800 text-neutral-200 rounded px-3 py-1.5 text-sm border border-neutral-700"
            value={provider.defaultAspectRatio}
            onChange={(e) => handleUpdate('defaultAspectRatio', e.target.value)}
          >
            {ASPECT_RATIOS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {actions.length > 0 && (
          <div className="pt-2 border-t border-neutral-700">
            <label className="block text-xs text-neutral-400 mb-2">Action Models</label>
            <div className="space-y-2">
              {actions.map((action) => {
                const currentModel = provider.actions?.[action.actionType]?.model;
                return (
                  <div key={action.id}>
                    <label className="block text-xs text-neutral-500 mb-1">{action.name}</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        className="flex-1 bg-neutral-800 text-neutral-200 rounded px-3 py-1.5 text-sm border border-neutral-700 focus:border-cyan-500 outline-none"
                        placeholder={currentModel ?? action.model}
                        value={actionModelInputs[action.actionType] ?? ''}
                        onChange={(e) =>
                          setActionModelInputs((prev) => ({
                            ...prev,
                            [action.actionType]: e.target.value
                          }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleActionModelSave(action.actionType);
                        }}
                      />
                      <button
                        className="text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded px-3 py-1.5"
                        onClick={() => handleActionModelSave(action.actionType)}
                      >
                        Save
                      </button>
                    </div>
                    {currentModel && (
                      <div className="text-xs text-neutral-500 mt-0.5">{currentModel}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
