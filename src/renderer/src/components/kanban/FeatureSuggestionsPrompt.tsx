import { Layers, Check, X } from 'lucide-react';
import { useKanbanStore } from '../../store/kanban-store';

/**
 * Slim banner listing the PM's pending feature-grouping suggestions (spec §4):
 * each row offers Accept (group the tickets into a feature) or Dismiss. Renders
 * nothing when there are no pending suggestions.
 */
export function FeatureSuggestionsPrompt(): React.JSX.Element | null {
  const suggestions = useKanbanStore((s) => s.suggestions);
  const accept = useKanbanStore((s) => s.acceptSuggestion);
  const dismiss = useKanbanStore((s) => s.dismissSuggestion);

  const pending = suggestions.filter((s) => s.status === 'pending');
  if (pending.length === 0) return null;

  return (
    <div className="border-b border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-[11px] text-neutral-400">
      {pending.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-0.5">
          <Layers size={12} className="text-sky-400" />
          <span className="font-medium text-neutral-300">{s.name}</span>
          <span className="text-neutral-500">({s.taskIds.length} tasks)</span>
          {s.reason && <span className="text-neutral-500">{s.reason}</span>}
          <span className="ml-auto inline-flex items-center gap-1.5">
            <button
              onClick={() => void accept(s.id)}
              className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 text-emerald-400 transition active:scale-[0.97] hover:bg-neutral-800"
              title="Group these tickets into a feature"
            >
              <Check size={11} />
              Accept
            </button>
            <button
              onClick={() => void dismiss(s.id)}
              className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 transition active:scale-[0.97] hover:bg-neutral-800"
              title="Dismiss this suggestion"
            >
              <X size={11} />
              Dismiss
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
