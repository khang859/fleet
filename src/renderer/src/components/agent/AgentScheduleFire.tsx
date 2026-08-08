import { Clock } from 'lucide-react';
import { splitScheduleFire } from '../../../../shared/agent-schedule';

/**
 * A check-in the conversation set for itself, arriving.
 *
 * A card rather than a bubble, because nobody said it. The bubble is the user's
 * and flat prose is the model's, and a message that is neither - written by this
 * conversation last Tuesday, delivered by Fleet at nine this morning - would be
 * read as one of them by whoever scrolls past it. What it has to say first is
 * that the turn under it started on its own.
 *
 * Always open, unlike the compaction summary it is otherwise shaped like. A note
 * is a sentence or two and is exactly the thing worth reading here: it is the
 * whole of what the turn below was given to work from.
 */
export function AgentScheduleFire({ text }: { text: string }): React.JSX.Element {
  const { opening, note } = splitScheduleFire(text);

  return (
    // Glass under it, unlike the compaction summary this is otherwise shaped
    // like. That card is collapsed to one line most of the time and what it
    // holds is background; this one is always open and the note inside it is
    // the whole brief for the turn below - and a pane with a photograph behind
    // it is exactly where that would become the hardest thing on screen to
    // read. Dashed still, because nobody typed it.
    <div className="rounded-lg border border-dashed border-fleet-border bg-fleet-glass-surface px-3 py-2 backdrop-blur-md">
      <div className="flex items-center gap-1.5 text-[11px] tracking-wider text-fleet-text-subtle uppercase">
        <Clock size={12} className="shrink-0" />
        Scheduled check-in
      </div>
      {/* How late it is, in the words the model was given: one place says it, so
          the user and the turn below cannot be told two different things. */}
      {opening !== '' && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-fleet-text-subtle">{opening}</p>
      )}
      {/* The note verbatim, and not as Markdown: it is a message to a stranger
          rather than model prose, and what was written down is what should be
          on screen.  */}
      <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap text-fleet-text-secondary">
        {note}
      </p>
    </div>
  );
}
