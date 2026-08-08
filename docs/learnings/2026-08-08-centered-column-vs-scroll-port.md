# A centered column lines up with its neighbours only if they share a box

Reported against the Agent pane: with the tasks card up, the composer was visibly left of the pane's center line while the Agent/Sessions/Settings tabs above it stayed centered.
Two separate causes, and the second one is the reusable lesson.

## Cause 1 - `mx-auto` centers in the box it is in, not in the pane

`AgentPane` lays the conversation and the card column out as flex siblings: the column takes a fixed 272px, the conversation takes the rest.
The conversation's rows are all `mx-auto w-full max-w-2xl`, so they centered in *pane minus column* - 136px (half the column) left of where the tabs, which span the whole pane, put their own center.

Nothing about this is visible until the agent first writes a plan, at which point the entire reading column slides sideways mid-conversation.

## Fix 1 - give the conversation the same width back on the other side

`centeringGutterPx()` in `src/renderer/src/components/agent/side-column.ts` returns a left gutter equal to the column, applied as `padding-left` on a wrapper around `AgentThread`.
Two centers, one line.

It is clamped to `width - SIDE_COLUMN_WIDTH_PX - READING_COLUMN_MAX_PX` rather than always the full 272px, because a pane can be wide enough to earn a column (950px) and still too narrow to be symmetric about one (needs 1216px).
Only genuinely spare room is given away, so a narrow pane loses the centering rather than the reading width.

## Cause 2 - a styled scrollbar is a *classic* scrollbar

This one is worth remembering well beyond this pane.

`index.css` styles `*::-webkit-scrollbar`.
The moment you style that pseudo-element in Chromium, the scrollbar stops being an overlay scrollbar and becomes a classic one: its width is **real layout width, taken off the right edge of the scroll port**.

So a scroll port is 6px narrower on the inside than it looks, and it is narrower asymmetrically.
The transcript reads inside the port; the composer, the status line and the location line sit outside it.
The same `mx-auto max-w-2xl` therefore landed in two different places:

- port wide enough for the column to reach 672px: the transcript's column centered in `port - 6`, i.e. **3px left** of the composer's.
- port too narrow for that: both columns filled what they were given, so their left edges matched and the transcript stopped **6px short** on the right.

The offset also appears and disappears with scrollability, so a growing conversation nudges itself sideways.

## Fix 2 - make the port symmetric and let the neighbours match it

```css
.fleet-scroll-balanced { scrollbar-gutter: stable both-edges; }
.fleet-scroll-inset { padding-inline: var(--fleet-scrollbar); }
```

`stable` keeps the gutter reserved whether or not there is anything to scroll (no jump when the conversation outgrows the viewport); `both-edges` mirrors it on the left so the port's content box is centered inside the port.
The non-scrolling rows are wrapped in one element carrying the same inset, so every box in the reading column is identical at every pane width.

The 6px is `--fleet-scrollbar` now, because two rules have to agree on it - the scrollbar's own width and the inset that compensates for it.

## Takeaways

- `mx-auto` centers against the parent's content box. If a sibling eats fixed width, the "centered" thing is not centered in what the user sees as the pane. Balance it with an equal gutter.
- In this app, **every scroll port is 6px narrower than its border box**, because the scrollbar is styled and therefore classic. Any content that has to align with something outside the port must account for it - `scrollbar-gutter: stable both-edges` inside, matching `padding-inline` outside.
- Verify this class of bug by measurement, not by eye: `npm run drive -- eval` and compare `getBoundingClientRect()` of the boxes that are supposed to line up. 3px is invisible in a screenshot and obvious in the numbers.
