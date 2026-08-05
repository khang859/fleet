import { FoldVertical, Loader2 } from 'lucide-react';
import { formatTokens } from './settings/format';

/**
 * How full the context window is, and the button that empties some of it.
 *
 * Compaction is otherwise invisible - it happens between turns and quietly
 * rewrites the transcript - so the number it acts on is on screen the whole
 * time. Without a context limit for the model there is no percentage to show,
 * and the bar is left out rather than faked.
 */
export function AgentContextMeter({
  used,
  limit,
  threshold,
  compacting,
  canCompact,
  onCompact
}: {
  used: number;
  limit: number | null;
  /** Where automatic compaction kicks in, as a fraction. `null` ⇒ manual only. */
  threshold: number | null;
  compacting: boolean;
  canCompact: boolean;
  onCompact: () => void;
}): React.JSX.Element {
  const fraction = limit === null || limit <= 0 ? null : used / limit;
  const high = fraction !== null && threshold !== null && fraction >= threshold;

  return (
    <div className="mx-auto flex w-full max-w-2xl items-center justify-end gap-2 px-4 pb-1.5 text-[11px] text-fleet-text-subtle">
      {compacting ? (
        <span className="flex items-center gap-1.5 text-fleet-text-muted">
          <Loader2 size={11} className="animate-spin" />
          Compacting context…
        </span>
      ) : (
        <>
          {fraction !== null && (
            <span
              className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-fleet-surface-2"
              role="presentation"
            >
              <span
                className={`block h-full rounded-full transition-[width] duration-300 ${
                  high ? 'bg-amber-400' : 'bg-fleet-text-subtle'
                }`}
                // Floored at a sliver: a bar with nothing in it at all is hard to
                // tell from a track, and an empty window should not read as a full one.
                style={{ width: `${Math.min(100, Math.max(3, Math.round(fraction * 100)))}%` }}
              />
            </span>
          )}
          <span
            className={`tabular-nums ${high ? 'text-amber-400' : ''}`}
            title={
              limit === null
                ? 'The catalog does not list this model’s context window, so Fleet will not compact on its own.'
                : `Tokens the next turn will send, out of the model's ${formatTokens(limit)} context window.`
            }
          >
            {limit === null
              ? `${formatTokens(used)} context`
              : `${formatTokens(used)} / ${formatTokens(limit)}`}
          </span>
          {canCompact && (
            <button
              type="button"
              onClick={onCompact}
              title="Summarize the earlier messages to free context"
              className="flex items-center gap-1 rounded px-1 py-0.5 text-fleet-text-subtle transition-colors hover:text-fleet-text-secondary focus-ring"
            >
              <FoldVertical size={11} />
              Compact
            </button>
          )}
        </>
      )}
    </div>
  );
}
