import type { PiModel } from '../../../../../shared/pi-config-types';

type Props = {
  models: PiModel[];
  onChange: (next: PiModel[]) => void;
};

export function PiModelsEditor({ models, onChange }: Props): React.JSX.Element {
  const update = (index: number, patch: Partial<PiModel>): void => {
    const next = models.map((m, i) => (i === index ? { ...m, ...patch } : m));
    onChange(next);
  };
  const remove = (index: number): void => onChange(models.filter((_, i) => i !== index));
  const add = (): void => onChange([...models, { id: '' }]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs text-neutral-400">Models</label>
        <button
          type="button"
          onClick={add}
          className="text-xs px-2 py-0.5 bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-200 transition active:scale-[0.97]"
        >
          + Add model
        </button>
      </div>

      {models.length === 0 && (
        <p className="text-xs text-neutral-600 italic">No models. Add at least one.</p>
      )}

      <div className="space-y-1">
        {models.map((m, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_1fr_90px_90px_auto_auto] gap-2 items-center text-xs"
          >
            <input
              type="text"
              value={m.id}
              onChange={(e) => update(i, { id: e.target.value })}
              placeholder="model-id"
              className="bg-neutral-800 rounded px-2 py-1 border border-neutral-700 text-neutral-200 font-mono"
            />
            <input
              type="text"
              value={m.name ?? ''}
              onChange={(e) => update(i, { name: e.target.value || undefined })}
              placeholder="Display name"
              className="bg-neutral-800 rounded px-2 py-1 border border-neutral-700 text-neutral-200"
            />
            <input
              type="number"
              value={m.contextWindow ?? ''}
              onChange={(e) =>
                update(i, { contextWindow: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="ctx"
              className="bg-neutral-800 rounded px-2 py-1 border border-neutral-700 text-neutral-200"
            />
            <input
              type="number"
              value={m.maxTokens ?? ''}
              onChange={(e) =>
                update(i, { maxTokens: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="max"
              className="bg-neutral-800 rounded px-2 py-1 border border-neutral-700 text-neutral-200"
            />
            <label className="flex items-center gap-1 text-neutral-400">
              <input
                type="checkbox"
                checked={m.reasoning ?? false}
                onChange={(e) => update(i, { reasoning: e.target.checked || undefined })}
              />
              reason
            </label>
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-neutral-500 hover:text-red-400 px-1 transition active:scale-90"
              aria-label="Remove model"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
