import { GitPullRequest, Check, X, Clock } from 'lucide-react';
import { useKanbanStore } from '../../store/kanban-store';
import { featureProgress } from './kanban-utils';

const CHECKS_GLYPH = {
  passing: { Icon: Check, style: 'text-emerald-400', label: 'passing' },
  failing: { Icon: X, style: 'text-red-400', label: 'failing' },
  pending: { Icon: Clock, style: 'text-amber-400', label: 'pending' }
} as const;

/**
 * Slim PR-rollup strip shown under the board toolbar while a feature is focused.
 * Counts come from the in-store cards (no fetch), so it stays live with the board.
 * Renders nothing when the focused feature has no PRs yet.
 */
export function FeaturePrRollup(): React.JSX.Element | null {
  const cards = useKanbanStore((s) => s.cards);
  const selectedFeatureId = useKanbanStore((s) => s.selectedFeatureId);
  if (!selectedFeatureId) return null;
  const p = featureProgress(cards.filter((c) => c.featureId === selectedFeatureId));
  if (p.openPr === 0 && p.mergedPr === 0) return null;
  const checks = p.checks ? CHECKS_GLYPH[p.checks] : null;
  return (
    <div className="flex items-center gap-3 border-b border-neutral-800 bg-neutral-900/60 px-3 py-1 text-[11px] text-neutral-400">
      <span className="inline-flex items-center gap-1 text-neutral-300">
        <GitPullRequest size={12} className="text-sky-400" />
        {p.openPr} open · {p.mergedPr} merged
      </span>
      {checks && (
        <span className={`inline-flex items-center gap-1 ${checks.style}`}>
          <checks.Icon size={12} /> checks {checks.label}
        </span>
      )}
    </div>
  );
}
