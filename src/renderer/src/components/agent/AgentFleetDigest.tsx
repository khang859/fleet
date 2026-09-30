import { useState } from 'react';
import { Radar } from 'lucide-react';
import { splitFleetDigest, unfence } from '../../../../shared/fleet-tools';

/**
 * Fleet waking an orchestrator pane because sessions it looks after need
 * attention.
 *
 * A card for the reason the scheduled check-in is one: nobody in the room said
 * it, and the turn under it started on its own. The headlines stay open, since
 * they are what the turn below is answering; the detail under them is the
 * sessions' own text, often long, so it folds away like a compaction summary.
 */
export function AgentFleetDigest({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { headlines, details } = splitFleetDigest(text);

  return (
    // Glass and dashes as the check-in has them: always partly open, and
    // written by Fleet rather than typed.
    <div className="rounded-lg border border-dashed border-fleet-border bg-fleet-glass-surface px-3 py-2 backdrop-blur-md">
      <div className="flex items-center gap-1.5 text-[11px] tracking-wider text-fleet-text-subtle uppercase">
        <Radar size={12} className="shrink-0" />
        Session update
        {details !== '' && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="ml-auto tracking-normal normal-case transition-colors hover:text-fleet-text-muted focus-ring"
          >
            {open ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      <ul className="mt-1.5 space-y-0.5 text-sm leading-relaxed text-fleet-text-secondary">
        {headlines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      {/* The sessions' words, not the model's: as written, never as Markdown. */}
      {open && (
        <p className="mt-2 text-xs leading-relaxed whitespace-pre-wrap text-fleet-text-muted">
          {unfence(details)}
        </p>
      )}
    </div>
  );
}
