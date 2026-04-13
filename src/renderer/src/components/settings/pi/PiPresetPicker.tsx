import { PI_PRESETS, type PiPresetId } from '../../../../../shared/pi-presets';

type Props = {
  onPick: (id: PiPresetId) => void;
  onClose: () => void;
};

export function PiPresetPicker({ onPick, onClose }: Props): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="max-w-lg w-full bg-neutral-900 border border-neutral-700 rounded p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-neutral-100">Add Provider</h3>
        <p className="text-xs text-neutral-500">Pick a preset — you can edit everything after.</p>
        <div className="grid grid-cols-2 gap-2">
          {PI_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p.id)}
              className="text-left p-3 border border-neutral-700 rounded hover:border-blue-500 hover:bg-neutral-800"
            >
              <div className="text-sm text-neutral-200">{p.label}</div>
              <div className="text-xs text-neutral-500 mt-1">{p.description}</div>
            </button>
          ))}
        </div>
        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-sm rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
