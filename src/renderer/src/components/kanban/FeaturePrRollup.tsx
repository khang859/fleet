import { useState } from 'react';
import { GitPullRequest, Check, X, Clock, GitMerge, Rocket, RefreshCw } from 'lucide-react';
import { useKanbanStore } from '../../store/kanban-store';
import { featureProgress } from './kanban-utils';

const CHECKS_GLYPH = {
  passing: { Icon: Check, style: 'text-emerald-400', label: 'passing' },
  failing: { Icon: X, style: 'text-red-400', label: 'failing' },
  pending: { Icon: Clock, style: 'text-amber-400', label: 'pending' }
} as const;

/**
 * Slim feature-coordination strip shown under the board toolbar while a feature is
 * focused: per-task PR rollup (live from in-store cards) plus the feature-level
 * integration-branch actions — Sync with main and Ship (open the one feature→main
 * PR). Renders nothing until the feature has either PRs or an integration branch.
 */
export function FeaturePrRollup(): React.JSX.Element | null {
  const cards = useKanbanStore((s) => s.cards);
  const features = useKanbanStore((s) => s.features);
  const selectedFeatureId = useKanbanStore((s) => s.selectedFeatureId);
  const shipFeature = useKanbanStore((s) => s.shipFeature);
  const syncFeature = useKanbanStore((s) => s.syncFeature);
  const [busy, setBusy] = useState<'ship' | 'sync' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const feature = features.find((f) => f.id === selectedFeatureId) ?? null;
  if (!feature) return null;
  const p = featureProgress(cards.filter((c) => c.featureId === feature.id));
  const hasPrs = p.openPr > 0 || p.mergedPr > 0;
  if (!hasPrs && !feature.integrationBranch && !feature.prUrl) return null;
  const checks = p.checks ? CHECKS_GLYPH[p.checks] : null;

  async function run(action: 'ship' | 'sync'): Promise<void> {
    if (!feature) return;
    setBusy(action);
    setErr(null);
    setMsg(null);
    try {
      const res = action === 'ship' ? await shipFeature(feature.id) : await syncFeature(feature.id);
      if (res.ok) setMsg(res.prUrl ?? res.message ?? 'Done');
      else setErr(res.error ?? 'Action failed');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-800 bg-neutral-900/60 px-3 py-1 text-[11px] text-neutral-400">
      {hasPrs && (
        <span className="inline-flex items-center gap-1 text-neutral-300">
          <GitPullRequest size={12} className="text-sky-400" />
          {p.openPr} open · {p.mergedPr} merged
        </span>
      )}
      {checks && (
        <span className={`inline-flex items-center gap-1 ${checks.style}`}>
          <checks.Icon size={12} /> checks {checks.label}
        </span>
      )}
      {feature.integrationBranch && (
        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-neutral-500">
          <GitMerge size={11} /> {feature.integrationBranch}
        </span>
      )}
      {feature.prUrl && (
        <a
          href={feature.prUrl}
          target="_blank"
          rel="noreferrer"
          className={`inline-flex items-center gap-1 underline ${
            feature.prState === 'draft' ? 'text-neutral-400' : 'text-violet-300'
          }`}
        >
          <Rocket size={11} /> {feature.prState === 'draft' ? 'draft PR' : 'feature PR'}
        </a>
      )}

      <span className="ml-auto inline-flex items-center gap-1.5">
        {feature.integrationBranch && (
          <button
            onClick={() => void run('sync')}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 transition active:scale-[0.97] hover:bg-neutral-800 disabled:opacity-50 disabled:active:scale-100"
            title="Merge the latest main into the integration branch"
          >
            <RefreshCw size={11} />
            {busy === 'sync' ? 'Syncing…' : 'Sync main'}
          </button>
        )}
        {feature.integrationBranch && (
          <button
            onClick={() => void run('ship')}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 rounded bg-violet-700 px-2 py-0.5 font-medium text-white transition active:scale-[0.97] hover:bg-violet-600 disabled:opacity-50 disabled:active:scale-100"
            title="Open the single feature→main pull request"
          >
            <Rocket size={11} />
            {busy === 'ship' ? 'Shipping…' : 'Ship feature'}
          </button>
        )}
      </span>

      {msg && (
        <span className="w-full break-all text-emerald-400">
          {msg.startsWith('http') ? (
            <a href={msg} target="_blank" rel="noreferrer" className="underline">
              {msg}
            </a>
          ) : (
            msg
          )}
        </span>
      )}
      {err && <span className="w-full text-red-400">{err}</span>}
    </div>
  );
}
