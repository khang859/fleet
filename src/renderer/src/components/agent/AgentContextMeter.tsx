import { FoldVertical } from 'lucide-react';
import { projectInstructionsNotice } from '../../../../shared/agent-project-instructions';
import { formatTokens } from './settings/format';

/**
 * How full the context window is, and the button that empties some of it.
 *
 * Compaction is otherwise invisible - it happens between turns and quietly
 * rewrites the transcript - so the number it acts on is on screen the whole
 * time, the compaction itself included: the count stays put while it runs, so
 * the drop is something you watch happen. Without a context limit for the
 * model there is no percentage to show, and the bar is left out rather than
 * faked.
 *
 * It is also where the project's own instructions file is accounted for, which
 * is the one thing here that is not about compaction. `AGENTS.md` is never
 * truncated, so a large one is context pressure of the most permanent kind:
 * present before the first message and never compacted away. That is the same
 * thing this meter already measures, arriving earlier - which is why the warning
 * goes here rather than into a log nobody reads or a settings tab you only open
 * once you have decided something is wrong.
 */
export function AgentContextMeter({
  used,
  limit,
  threshold,
  canCompact,
  onCompact,
  projectInstructions
}: {
  used: number;
  limit: number | null;
  /** Where automatic compaction kicks in, as a fraction. `null` ⇒ manual only. */
  threshold: number | null;
  canCompact: boolean;
  onCompact: () => void;
  /** The instructions file this folder has, if the last turn found one. */
  projectInstructions?: { filename: string; tokens: number } | null;
}): React.JSX.Element {
  const fraction = limit === null || limit <= 0 ? null : used / limit;
  const notice =
    projectInstructions === undefined || projectInstructions === null
      ? null
      : projectInstructionsNotice(projectInstructions.tokens, projectInstructions.filename);
  // Forced on past the threshold whatever the fill is: a window that is barely
  // used is still carrying the file, and it will be carrying it on every round
  // of every turn for as long as this folder is open.
  const high =
    (fraction !== null && threshold !== null && fraction >= threshold) || (notice?.warn ?? false);

  return (
    <span className="flex shrink-0 items-center gap-2">
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
        title={[
          limit === null
            ? 'The catalog does not list this model’s context window, so Fleet will not compact on its own.'
            : `Tokens the next turn will send, out of the model's ${formatTokens(limit)} context window.`,
          // Always, not only when it is large: "why does this session start at
          // 6k" is worth answering at any size.
          ...(notice === null ? [] : [notice.line])
        ].join('\n\n')}
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
    </span>
  );
}
