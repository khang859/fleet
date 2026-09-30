# A long path squeezed a short tab name to "m…"

Seen in the sidebar during the Phase 3 end-to-end run: a terminal tab called `math` read `m…`, beside a folder path that had the rest of the row.

## What happened

The tab row puts the name and a muted chip (branch, freshness or path) in one flex line, both `truncate`.
With the default `flex-shrink: 1` on both, the overflow is shared in proportion to their widths, so a long path took a few pixels off a short name.
Giving the chip `shrink-[100]` was not enough: the name still lost 0.23px (32.77 of 33), and a sub-pixel shortfall is all `text-overflow: ellipsis` needs.

## How it was fixed

The name is `shrink-0 max-w-full truncate`.
It keeps its natural width and is cut only when it alone is wider than the row, and the chip (`min-w-0 truncate`) gives up all its width first.

## How it was checked

In the running app, with a long path forced into the chip, `math` measured its full width and the path ended in an ellipsis.
A long custom name still truncated at the row edge.

## Takeaway

To make one flex child give way first, stop the other one shrinking and cap it with `max-w-full`, rather than weighting the shrink factors: weighting still takes a fraction of a pixel, and that is enough for an ellipsis.
