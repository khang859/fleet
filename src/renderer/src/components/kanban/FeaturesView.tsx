import { useMemo, useState } from 'react';
import {
  Layers,
  GitPullRequest,
  Check,
  X,
  Clock,
  Pencil,
  Target,
  Archive,
  RotateCcw,
  Plus
} from 'lucide-react';
import { useKanbanStore } from '../../store/kanban-store';
import { featureProgress, relativeTime } from './kanban-utils';
import { FeaturePickerModal } from './FeaturePickerModal';
import type { Feature, FeatureStatus, ChecksState } from '../../../../shared/kanban-types';

const STATUS_STYLE: Record<FeatureStatus, string> = {
  active: 'bg-emerald-500/20 text-emerald-300',
  shipped: 'bg-violet-500/20 text-violet-300',
  archived: 'bg-neutral-700 text-neutral-400'
};

const CHECKS_GLYPH: Record<ChecksState, { Icon: typeof Check; style: string }> = {
  passing: { Icon: Check, style: 'text-emerald-400' },
  failing: { Icon: X, style: 'text-red-400' },
  pending: { Icon: Clock, style: 'text-amber-400' }
};

/**
 * Cross-feature dashboard (a top-level Kanban view). Status/PR rollups are derived
 * from the in-store board cards — no extra fetch — so the dashboard stays live with
 * the board. "Focus" filters the board to one feature and returns the host there.
 */
export function FeaturesView({ onFocus }: { onFocus: () => void }): React.JSX.Element {
  const features = useKanbanStore((s) => s.features);
  const cards = useKanbanStore((s) => s.cards);
  const setFocusedFeature = useKanbanStore((s) => s.setFocusedFeature);
  const archiveFeature = useKanbanStore((s) => s.archiveFeature);
  const updateFeature = useKanbanStore((s) => s.updateFeature);

  const [statusFilter, setStatusFilter] = useState<FeatureStatus | 'all'>('active');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<{ feature: Feature | null } | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return features
      .filter((f) => statusFilter === 'all' || f.status === statusFilter)
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .map((f) => ({ feature: f, p: featureProgress(cards.filter((c) => c.featureId === f.id)) }));
  }, [features, cards, statusFilter, query]);

  function focus(id: string): void {
    setFocusedFeature(id);
    onFocus();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-neutral-900 text-neutral-200">
      <header className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-300">
          <Layers size={15} className="text-violet-400" /> Features
        </h2>
        <span className="text-[11px] text-neutral-600">{rows.length}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as FeatureStatus | 'all')}
            className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
          >
            <option value="active">Active</option>
            <option value="shipped">Shipped</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-40 rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
          />
          <button
            onClick={() => setEditor({ feature: null })}
            className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-white transition active:scale-[0.97] hover:bg-blue-500"
          >
            <Plus size={12} /> New feature
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {rows.length === 0 ? (
          <p className="mt-8 text-center text-xs text-neutral-600">
            No features match. Group tasks into a feature to track them as one unit.
          </p>
        ) : (
          <div className="space-y-4">
            {rows.map(({ feature, p }) => {
              const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
              const checks = p.checks ? CHECKS_GLYPH[p.checks] : null;
              return (
                <section
                  key={feature.id}
                  className="rounded-lg border border-neutral-800 bg-neutral-950 p-3"
                >
                  <div className="flex items-center gap-2">
                    <h3
                      className="truncate text-sm font-semibold text-neutral-200"
                      title={feature.name}
                    >
                      {feature.name}
                    </h3>
                    <span
                      className={`rounded px-1.5 text-[10px] uppercase tracking-wide ${STATUS_STYLE[feature.status]}`}
                    >
                      {feature.status}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5">
                      <button
                        onClick={() => focus(feature.id)}
                        className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 transition active:scale-[0.97] hover:bg-neutral-800"
                        title="Focus the board on this feature"
                      >
                        <Target size={11} /> Focus
                      </button>
                      <button
                        onClick={() => setEditor({ feature })}
                        className="rounded p-1 text-neutral-400 transition active:scale-90 hover:bg-neutral-800"
                        title="Edit feature"
                      >
                        <Pencil size={12} />
                      </button>
                      {feature.status === 'archived' ? (
                        <button
                          onClick={() => void updateFeature(feature.id, { status: 'active' })}
                          className="rounded p-1 text-neutral-400 transition active:scale-90 hover:bg-neutral-800"
                          title="Unarchive feature"
                        >
                          <RotateCcw size={12} />
                        </button>
                      ) : (
                        <button
                          onClick={() => void archiveFeature(feature.id)}
                          className="rounded p-1 text-neutral-400 transition active:scale-90 hover:bg-neutral-800"
                          title="Archive feature"
                        >
                          <Archive size={12} />
                        </button>
                      )}
                    </span>
                  </div>

                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                    <div className="h-full bg-emerald-500/70" style={{ width: `${pct}%` }} />
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-400">
                    <span>
                      {p.done}/{p.total} done
                    </span>
                    {p.running > 0 && <span className="text-blue-300">{p.running} running</span>}
                    {p.review > 0 && <span className="text-amber-300">{p.review} review</span>}
                    {p.todo > 0 && <span>{p.todo} todo</span>}
                    {(p.openPr > 0 || p.mergedPr > 0) && (
                      <span className="inline-flex items-center gap-1 text-sky-300">
                        <GitPullRequest size={11} /> {p.openPr} open · {p.mergedPr} merged
                      </span>
                    )}
                    {checks && (
                      <span className={`inline-flex items-center gap-0.5 ${checks.style}`}>
                        <checks.Icon size={11} /> checks
                      </span>
                    )}
                    {feature.baseBranch && (
                      <span className="font-mono text-[10px] text-neutral-600">
                        → {feature.baseBranch}
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-neutral-600">
                      updated {relativeTime(feature.updatedAt)}
                    </span>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      <FeaturePickerModal
        open={editor !== null}
        feature={editor?.feature ?? null}
        onClose={() => setEditor(null)}
      />
    </div>
  );
}
