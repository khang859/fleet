import type { TaskPrInfo, PrState, ChecksState } from '../../../../shared/kanban-types';
import { GitPullRequest, Check, X, Clock } from 'lucide-react';

const STATE_STYLE: Record<PrState, string> = {
  open: 'bg-emerald-500/20 text-emerald-300',
  merged: 'bg-violet-500/20 text-violet-300',
  closed: 'bg-neutral-700 text-neutral-400 line-through',
  draft: 'border border-dashed border-neutral-600 text-neutral-400'
};

const CHECKS: Record<ChecksState, { style: string; Icon: typeof Check; label: string }> = {
  passing: { style: 'text-emerald-400', Icon: Check, label: 'checks passing' },
  failing: { style: 'text-red-400', Icon: X, label: 'checks failing' },
  pending: { style: 'text-amber-400', Icon: Clock, label: 'checks pending' }
};

/**
 * Compact PR status chip: state pill (#number) plus an optional checks glyph.
 * Renders nothing when the task has no resolvable PR state.
 */
export function PrStatusBadge({ pr }: { pr: TaskPrInfo }): React.JSX.Element | null {
  if (!pr.state) return null;
  const checks = pr.checksState ? CHECKS[pr.checksState] : null;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded px-1 ${STATE_STYLE[pr.state]}`}
      title={`PR ${pr.state}${pr.number != null ? ` #${pr.number}` : ''}`}
    >
      <GitPullRequest size={10} />
      {pr.number != null ? `#${pr.number}` : pr.state}
      {checks && <checks.Icon size={10} className={`ml-0.5 ${checks.style}`} />}
    </span>
  );
}
