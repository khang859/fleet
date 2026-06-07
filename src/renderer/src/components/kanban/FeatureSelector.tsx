import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { useKanbanStore } from '../../store/kanban-store';
import { FeaturePickerModal } from './FeaturePickerModal';
import type { Feature } from '../../../../shared/kanban-types';

/**
 * Toolbar control to focus the board on a single feature. The dropdown lists active
 * features plus "All features" and a "New feature…" sentinel; the pencil edits the
 * focused feature.
 */
export function FeatureSelector(): React.JSX.Element {
  const features = useKanbanStore((s) => s.features);
  const selectedFeatureId = useKanbanStore((s) => s.selectedFeatureId);
  const setFocusedFeature = useKanbanStore((s) => s.setFocusedFeature);
  const [editor, setEditor] = useState<{ feature: Feature | null } | null>(null);

  const active = features.filter((f) => f.status === 'active');
  const focused = features.find((f) => f.id === selectedFeatureId) ?? null;

  return (
    <>
      <select
        value={selectedFeatureId ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__new__') setEditor({ feature: null });
          else setFocusedFeature(v === '' ? null : v);
        }}
        className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs outline-none focus:border-blue-500"
        title="Focus a feature"
      >
        <option value="">All features</option>
        {active.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
        <option value="__new__">＋ New feature…</option>
      </select>
      <button
        onClick={() => focused && setEditor({ feature: focused })}
        disabled={!focused}
        className="rounded px-2 py-1 text-xs text-neutral-400 transition hover:bg-neutral-800 active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100"
        title="Edit focused feature"
      >
        <Pencil size={12} />
      </button>
      <FeaturePickerModal
        open={editor !== null}
        feature={editor?.feature ?? null}
        onClose={() => setEditor(null)}
      />
    </>
  );
}
