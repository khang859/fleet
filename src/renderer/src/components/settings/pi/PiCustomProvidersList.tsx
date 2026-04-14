import { useMemo, useState } from 'react';
import type { PiModelsFile, PiProvider } from '../../../../../shared/pi-config-types';
import { getPreset, type PiPresetId, PI_PRESETS } from '../../../../../shared/pi-presets';
import { PiProviderForm } from './PiProviderForm';
import { PiPresetPicker } from './PiPresetPicker';

type Draft = {
  existingId: string | null;
  presetId: PiPresetId;
  id: string;
  provider: PiProvider;
};

type Props = {
  models: PiModelsFile;
  onWrite: (id: string, provider: PiProvider) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onReload: () => Promise<void>;
};

function inferPresetId(_id: string, provider: PiProvider): PiPresetId {
  const url = provider.baseUrl ?? '';
  if (url.includes('11434')) return 'ollama';
  if (url.includes('1234')) return 'lm-studio';
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('ai-gateway.vercel.sh')) return 'vercel-gateway';
  return 'custom';
}

export function PiCustomProvidersList({
  models,
  onWrite,
  onDelete,
  onReload
}: Props): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pickerOpen, setPickerOpen] = useState(false);

  const existingIds = useMemo(() => Object.keys(models.providers), [models]);

  const startEdit = (id: string): void => {
    const provider = models.providers[id];
    setDrafts((d) => ({
      ...d,
      [id]: { existingId: id, presetId: inferPresetId(id, provider), id, provider }
    }));
  };

  const startAdd = (presetId: PiPresetId): void => {
    setPickerOpen(false);
    const preset = getPreset(presetId);
    let baseId = preset.defaultProviderId;
    let i = 1;
    while (existingIds.includes(baseId) || baseId in drafts) {
      baseId = `${preset.defaultProviderId}-${i++}`;
    }
    setDrafts((d) => ({
      ...d,
      [`__new__${baseId}`]: {
        existingId: null,
        presetId,
        id: baseId,
        provider: { ...preset.defaults }
      }
    }));
  };

  const cancelDraft = (draftKey: string): void => {
    setDrafts((d) => {
      const next = { ...d };
      delete next[draftKey];
      return next;
    });
  };

  const saveDraft = async (draftKey: string, id: string, provider: PiProvider): Promise<void> => {
    const draft = drafts[draftKey];
    if (!draft) return;
    if (draft.existingId && draft.existingId !== id) {
      await onDelete(draft.existingId);
    }
    await onWrite(id, provider);
    await onReload();
    cancelDraft(draftKey);
  };

  const deleteDraft = async (draftKey: string): Promise<void> => {
    const draft = drafts[draftKey];
    if (!draft) return;
    if (draft.existingId) {
      const ok = window.confirm(`Delete provider "${draft.existingId}"?`);
      if (!ok) return;
      await onDelete(draft.existingId);
      await onReload();
    }
    cancelDraft(draftKey);
  };

  const orderedEntries = useMemo(
    () => Object.entries(models.providers).sort(([a], [b]) => a.localeCompare(b)),
    [models]
  );

  const hasAnyDraft = Object.keys(drafts).length > 0;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-200">Custom Providers</h2>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white"
        >
          + Add Provider
        </button>
      </div>

      {orderedEntries.length === 0 && !hasAnyDraft && (
        <p className="text-xs text-neutral-600 italic">
          No custom providers yet. Add one to configure AWS Bedrock, Ollama, proxies, etc.
        </p>
      )}

      <div className="space-y-2">
        {orderedEntries.map(([id, provider]) => {
          const draftKey = id;
          const draft = drafts[draftKey];
          const presetId = inferPresetId(id, provider);
          const presetLabel = PI_PRESETS.find((p) => p.id === presetId)?.label ?? 'Custom';
          const modelCount = provider.models?.length ?? 0;

          return (
            <div key={id} className="border border-neutral-700 rounded">
              <div className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2 text-sm text-neutral-200">
                  <span className="font-mono">{id}</span>
                  <span className="text-xs text-neutral-500 rounded bg-neutral-800 px-1.5 py-0.5">
                    {presetLabel}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {modelCount} model{modelCount === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="flex gap-2">
                  {!draft && (
                    <button
                      type="button"
                      onClick={() => startEdit(id)}
                      className="text-xs px-2 py-0.5 border border-neutral-700 rounded text-neutral-300 hover:bg-neutral-800"
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>
              {draft && (
                <PiProviderForm
                  initialId={draft.id}
                  initialProvider={draft.provider}
                  presetId={draft.presetId}
                  existingIds={existingIds.filter((eid) => eid !== draft.existingId)}
                  onSave={async (nid, np) => saveDraft(draftKey, nid, np)}
                  onDelete={async () => deleteDraft(draftKey)}
                  onCancel={() => cancelDraft(draftKey)}
                />
              )}
            </div>
          );
        })}

        {Object.entries(drafts)
          .filter(([, d]) => d.existingId === null)
          .map(([draftKey, draft]) => (
            <div key={draftKey} className="border border-blue-700/50 rounded">
              <div className="px-3 py-2 text-sm text-neutral-200 flex items-center gap-2">
                <span className="font-mono">{draft.id}</span>
                <span className="text-xs text-blue-400 rounded bg-blue-900/30 px-1.5 py-0.5">
                  new
                </span>
              </div>
              <PiProviderForm
                initialId={draft.id}
                initialProvider={draft.provider}
                presetId={draft.presetId}
                existingIds={existingIds}
                onSave={async (nid, np) => saveDraft(draftKey, nid, np)}
                onDelete={() => cancelDraft(draftKey)}
                onCancel={() => cancelDraft(draftKey)}
              />
            </div>
          ))}
      </div>

      {pickerOpen && <PiPresetPicker onPick={startAdd} onClose={() => setPickerOpen(false)} />}
    </section>
  );
}
