/**
 * A card in the column beside the conversation.
 *
 * The shell rather than either list: rounded, bordered, glass over whatever the
 * pane has behind it - the same card the composer is. A list of short lines read
 * straight off a photograph is the one thing in the pane small enough to
 * disappear into one, and the border is what gives it an edge on all four sides
 * rather than a slab that runs off the top and bottom.
 *
 * Shared because the two cards sit one above the other in the same column, and
 * any difference between them would read as one of them meaning something by it.
 * Written once so that stays true by construction rather than by two files
 * happening to hold the same string.
 *
 * The header is the same shape for both: what this is, and one number for how
 * much of it there is - `3/7` for a plan, `5` for a list with no end state.
 */
export function SideColumnCard({
  label,
  name,
  count,
  children
}: {
  /** The heading, as the user reads it. */
  label: string;
  /**
   * What the card is called to a screen reader, which needs more than the
   * heading does: `Tasks` is unambiguous under a heading in this column and
   * ambiguous as the name of a region of the whole window.
   */
  name: string;
  count: string;
  /** The list, which is the only part the two cards do differently. */
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <aside
      aria-label={name}
      // `min-h-0` so it can shrink past its content and its list scrolls inside
      // it; without it a long list would push the card off the bottom.
      // `overflow-hidden` so that scrolling list stays inside the corners.
      //
      // `flex-1 basis-0 max-h-fit` is how two of these share a column too short
      // for both: each asks for an equal share of it rather than for its own
      // content, and hands back whatever of that share it does not need. Plain
      // shrinking gets this backwards - the deficit is shared out in proportion
      // to what each card holds, so five subagents at three lines each take
      // twice the room of a ten-item plan and the plan is the one squeezed to a
      // sliver. This way a short list still hugs its content, a long one still
      // scrolls, and neither card can crowd the other out by having more to say.
      className="flex max-h-fit min-h-0 flex-1 basis-0 flex-col overflow-hidden rounded-xl border border-fleet-border bg-fleet-glass-surface shadow-lg backdrop-blur-md"
    >
      <div className="flex shrink-0 items-baseline gap-2 px-3 pt-2.5 pb-1.5">
        <h2 className="text-[11px] font-medium tracking-wide text-fleet-text-secondary uppercase">
          {label}
        </h2>
        <span className="ml-auto font-mono text-[11px] text-fleet-text-subtle tabular-nums">
          {count}
        </span>
      </div>
      {children}
    </aside>
  );
}
